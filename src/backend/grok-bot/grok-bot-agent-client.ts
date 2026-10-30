import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentClient, DiagnosticOrigin } from "../agent-client";
import { PendingServerRequests } from "../pending-server-requests";
import type {
  AppServerNotification,
  AppServerRequest,
  DynamicToolResult,
  RequestId,
  ResponseDecoder,
  RpcError,
} from "../protocol";
import { getString, isRecord } from "../protocol";
import { type ProviderClientOperationError, providerFailure } from "../provider-client-effects";
import { accessTokenNeedsRefresh, type GrokBotAccountStore } from "./grok-bot-account";
import { readOrCreateMachineId } from "./grok-bot-checksum";
import { createGrokBotAgent, listGrokBotAgents, readGrokBotTranscript, sendGrokBotPrompt } from "./grok-bot-gateway";
import {
  GROK_BOT_MAX_IMAGE_BYTES,
  GROK_BOT_MODEL_ID,
  type GrokBotAdvertisedTool,
  type GrokBotImagePart,
  type GrokBotInferenceMessage,
  type GrokBotStreamTool,
  type GrokBotTextPart,
  type GrokBotToolCall,
  type GrokBotToolResultPart,
  grokBotStreamBody,
  readGrokBotInference,
} from "./grok-bot-inference";
import { transcriptToMessages } from "./grok-bot-transcript";
import { readGrokBotUsageSummary } from "./grok-bot-usage";

const DEFAULT_API = "https://api2.cursor.sh";

interface ClientEvents {
  notification: [AppServerNotification];
  request: [AppServerRequest];
  exit: [Error];
  diagnostic: [string, DiagnosticOrigin?];
}

interface SandThread {
  id: string;
  instructions: string | null;
  messages: GrokBotInferenceMessage[];
  tools: readonly GrokBotAdvertisedTool[];
  turn: { id: string; itemId: string; text: string; controller: AbortController } | null;
}

export interface GrokBotAgentClientOptions {
  readonly store?: GrokBotAccountStore;
  readonly requestTimeoutMs?: number;
  readonly apiBaseUrl?: string;
  readonly allowLoopback?: boolean;
  readonly fetchImpl?: typeof fetch;
  /** A fixed machine id. Tests use this. A path is used when this is absent. */
  readonly machineId?: string;
  readonly machineIdPath?: string;
  readonly checksumNow?: () => number;
  /** Call `InferenceService/Stream` directly (old path). Off by default: BotAI uses the box gateway. */
  readonly directInference?: boolean;
  readonly gatewayPollMs?: number;
  readonly gatewayTurnTimeoutMs?: number;
}

/**
 * One OpenBot thread is one sand agent id from `POST /api/createAgent`.
 * A turn is `InferenceService.Stream` with the sand access token, not the Grok CLI and not
 * `sendPrompt`. Tool-call parts are not executed: BotAI runs those in its host runner.
 */
export class GrokBotAgentClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "grok-bot" as const;
  readonly contextCompaction = "unsupported" as const;
  #running = false;
  #machineId: string | null = null;
  readonly #threads = new Map<string, SandThread>();
  readonly #requests = new PendingServerRequests((request) => this.emit("request", request));
  readonly #options: GrokBotAgentClientOptions;

  constructor(options: GrokBotAgentClientOptions = {}) {
    super();
    this.#options = options;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    this.#running = true;
  }

  stop(): Effect.Effect<void, ProviderClientOperationError> {
    this.#running = false;
    this.#requests.rejectAll(sourceText("error.provider.grokBotSessionEnded"));
    for (const thread of this.#threads.values()) thread.turn?.controller.abort();
    this.#threads.clear();
    return Effect.void;
  }

  notify(): void {
    /* OpenBot sends `initialized` after `initialize`. This client has nothing to start. */
  }

  respond(id: RequestId, result: unknown): void {
    this.#requests.resolve(id, result);
  }

  respondError(id: RequestId, error: RpcError): void {
    this.#requests.reject(id, error);
  }

  readonly request = Effect.fn("GrokBotAgentClient.request")(function* <T>(
    this: GrokBotAgentClient,
    method: string,
    params: unknown,
    decoder: ResponseDecoder<T>,
  ): Effect.fn.Return<T, ProviderClientOperationError> {
    if (!this.#running) return yield* providerFailure(new Error(sourceText("error.provider.grokBotSessionEnded")));
    const response = yield* this.#dispatch(method, params);
    return yield* Effect.try({
      try: () => decoder(response),
      catch: (cause) => providerFailure(cause),
    });
  });

  readonly #dispatch = Effect.fn("GrokBotAgentClient.dispatch")(function* (
    this: GrokBotAgentClient,
    method: string,
    params: unknown,
  ) {
    switch (method) {
      case "initialize":
      case "plugin/list":
      case "config/read":
        return method === "plugin/list" ? { marketplaces: [] } : {};
      case "account/read":
        return yield* this.#account();
      case "account/rateLimits/read":
        return yield* this.#usage();
      case "model/list":
        return {
          data: [
            {
              model: GROK_BOT_MODEL_ID,
              displayName: "Grok Bot",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              reasoningEffortConfigurable: false,
            },
          ],
        };
      case "thread/start":
        return yield* this.#startThread(params);
      case "thread/resume":
        return yield* this.#resumeThread(params);
      case "thread/read":
        return { thread: { id: requiredId(params, "threadId"), turns: [] } };
      case "turn/start":
        return this.#startTurn(params);
      case "turn/interrupt":
        return this.#interrupt(params);
      default:
        return yield* providerFailure(new Error(sourceText("error.provider.grokBotTurnFailed")));
    }
  });

  readonly #account = Effect.fn("GrokBotAgentClient.account")(function* (this: GrokBotAgentClient) {
    const record = this.#options.store
      ? yield* this.#options.store.load().pipe(Effect.mapError(providerFailure))
      : null;
    return {
      account: record ? { type: "grok-bot", email: null } : null,
      requiresOpenaiAuth: false,
    };
  });

  readonly #usage = Effect.fn("GrokBotAgentClient.usage")(function* (this: GrokBotAgentClient) {
    if (!this.#options.store) return { rateLimits: null, rateLimitsByLimitId: null };
    const summary = yield* readGrokBotUsageSummary(this.#options.store, this.#callOptions()).pipe(
      Effect.mapError(providerFailure),
    );
    if (!summary || summary.includedUsedPercent === null) return { rateLimits: null, rateLimitsByLimitId: null };
    return {
      rateLimits: {
        primary: {
          usedPercent: summary.includedUsedPercent,
          windowDurationMins: null,
          resetsAt: summary.includedResetsAt,
        },
        secondary: null,
      },
      rateLimitsByLimitId: null,
    };
  });

  readonly #startThread = Effect.fn("GrokBotAgentClient.startThread")(function* (
    this: GrokBotAgentClient,
    params: unknown,
  ) {
    const store = this.#options.store;
    if (!store) return yield* providerFailure(new Error(sourceText("error.provider.grokBotNotSignedIn")));
    const created = yield* createGrokBotAgent(
      store,
      { name: "OpenBot", description: "" },
      { ...this.#callOptions(), allowLoopback: this.#options.allowLoopback === true },
    ).pipe(Effect.mapError(providerFailure));
    const instructions = isRecord(params) ? getString(params, "developerInstructions") : null;
    this.#threads.set(created.id, {
      id: created.id,
      instructions,
      messages: instructions ? [{ role: "SYSTEM", text: instructions }] : [],
      tools: advertisedTools(isRecord(params) ? params.dynamicTools : undefined),
      turn: null,
    });
    return { thread: { id: created.id } };
  });

  readonly #resumeThread = Effect.fn("GrokBotAgentClient.resumeThread")(function* (
    this: GrokBotAgentClient,
    params: unknown,
  ) {
    const id = requiredId(params, "threadId");
    const known = this.#threads.get(id);
    if (known) return { thread: { id: known.id } };
    const store = this.#options.store;
    if (!store) return yield* providerFailure(new Error(sourceText("error.provider.grokBotNotSignedIn")));
    const agents = yield* listGrokBotAgents(store, {
      ...this.#callOptions(),
      allowLoopback: this.#options.allowLoopback === true,
    }).pipe(Effect.mapError(providerFailure));
    if (!agents.some((agent) => agent.id === id)) {
      return yield* providerFailure(new Error("Grok Bot session not found"));
    }
    const instructions = isRecord(params) ? getString(params, "developerInstructions") : null;
    const history = yield* readGrokBotTranscript(store, id, {
      ...this.#callOptions(),
      allowLoopback: this.#options.allowLoopback === true,
    }).pipe(
      Effect.map((body) => transcriptToMessages(body)),
      Effect.catch(() => Effect.succeed([])),
    );
    this.#threads.set(id, {
      id,
      instructions,
      messages: [...(instructions ? [{ role: "SYSTEM" as const, text: instructions }] : []), ...history],
      tools: advertisedTools(isRecord(params) ? params.dynamicTools : undefined),
      turn: null,
    });
    return { thread: { id } };
  });

  #startTurn(params: unknown): { turn: { id: string; status: string } } {
    const threadId = requiredId(params, "threadId");
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error("Grok Bot session not found");
    if (thread.turn) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
    if (!hasPrompt(params)) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
    const listed = advertisedTools(isRecord(params) ? params.dynamicTools : undefined);
    if (listed.length > 0) thread.tools = listed;
    const model = isRecord(params) ? getString(params, "model") : null;
    const turnId = randomUUID();
    const controller = new AbortController();
    const itemId = `msg-${turnId}`;
    thread.turn = { id: turnId, itemId, text: "", controller };
    this.#emit("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    void (this.#options.directInference === true
      ? this.#stream(thread, params, model && model.length > 0 ? model : GROK_BOT_MODEL_ID)
      : this.#viaGateway(thread, params));
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async #stream(thread: SandThread, params: unknown, modelId: string): Promise<void> {
    const turn = thread.turn;
    const store = this.#options.store;
    if (!turn || !store) return;
    try {
      let record = await Effect.runPromise(store.load());
      if (!record) throw new Error(sourceText("error.provider.grokBotNotSignedIn"));
      // Match BotAI's getValidAccessToken: refresh the sand access token before InferenceService/Stream.
      const refresh = async (force: boolean) => {
        if (!record) return;
        if (!force && !accessTokenNeedsRefresh(record.accessToken, Date.now())) return;
        const next = await Effect.runPromise(store.refreshAccess(this.#callOptions()));
        if (!next) throw new Error(sourceText("error.provider.grokBotNotSignedIn"));
        record = next;
      };
      await refresh(false);
      const machineId = await this.#machine();
      let messages: GrokBotInferenceMessage[] = [...thread.messages, await userMessage(params)];
      let lastText = "";
      for (let round = 0; round < 8; round += 1) {
        const calls: GrokBotStreamTool[] = [];
        const roundText = { value: "" };
        const streamRound = (accessToken: string) =>
          readGrokBotInference({
            apiBaseUrl: this.#apiBase(),
            accessToken,
            machineId,
            ...(this.#options.checksumNow ? { checksumNow: this.#options.checksumNow } : {}),
            signal: turn.controller.signal,
            ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
            body: grokBotStreamBody({
              messages,
              tools: thread.tools,
              modelId,
              conversationId: thread.id,
              invocationId: `${turn.id}:${round}`,
            }),
            onEvent: (event) => {
              if (thread.turn?.id !== turn.id) return;
              if (event.kind === "tool") {
                if (event.isComplete) calls.push(event);
                else this.#emitTool(thread, turn.id, event, "inProgress");
                return;
              }
              if (event.kind === "thinking") {
                this.#emit("item/reasoning/textDelta", {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: `think-${turn.id}`,
                  delta: event.text,
                });
                return;
              }
              roundText.value += event.text;
              turn.text += event.text;
              this.#emit("item/agentMessage/delta", {
                threadId: thread.id,
                turnId: turn.id,
                itemId: turn.itemId,
                delta: event.text,
              });
            },
          });
        try {
          await streamRound(record.accessToken);
        } catch (error) {
          if (!isUnauthenticated(error) || roundText.value.length > 0 || calls.length > 0) throw error;
          await refresh(true);
          await streamRound(record.accessToken);
        }
        if (thread.turn?.id !== turn.id) return;
        lastText = roundText.value;
        if (calls.length === 0) break;
        const results: GrokBotToolResultPart[] = [];
        for (const call of calls) {
          results.push(await this.#runTool(thread, turn.id, call));
        }
        messages = [
          ...messages,
          {
            role: "ASSISTANT",
            text: roundText.value,
            toolCalls: calls.map((call) => toolCallRecord(call)),
          },
          { role: "TOOL", results },
        ];
      }
      if (thread.turn?.id !== turn.id) return;
      thread.messages = [...messages, { role: "ASSISTANT", text: lastText }];
      this.#emit("item/completed", {
        threadId: thread.id,
        turnId: turn.id,
        item: { type: "agentMessage", id: turn.itemId, text: turn.text, status: "completed" },
      });
      thread.turn = null;
      this.#emit("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "completed" } });
    } catch (error) {
      if (thread.turn?.id !== turn.id) return;
      if (turn.controller.signal.aborted) {
        thread.turn = null;
        this.#emit("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "interrupted" } });
        return;
      }
      thread.turn = null;
      const message = error instanceof Error ? error.message : sourceText("error.provider.grokBotTurnFailed");
      // Without an `error` notification the chat shows only the user message (the turn ends silently).
      this.emit("diagnostic", `Grok Bot turn failed: ${message}`);
      this.#emit("error", { threadId: thread.id, turnId: turn.id, message });
      this.#emit("turn/completed", {
        threadId: thread.id,
        turn: { id: turn.id, status: "failed", error: { message } },
      });
    }
  }

  /**
   * BotAI path: `/api/sendPrompt` on the in-box gateway, then follow `/api/getAgentTranscriptTail`
   * until the assistant reply for this turn stops changing.
   */
  async #viaGateway(thread: SandThread, params: unknown): Promise<void> {
    const turn = thread.turn;
    const store = this.#options.store;
    if (!turn || !store) return;
    const options = { ...this.#callOptions(), allowLoopback: this.#options.allowLoopback === true };
    const tail = async () =>
      transcriptToMessages(await Effect.runPromise(readGrokBotTranscript(store, thread.id, options)));
    try {
      const prompt = promptText(params);
      const none: GrokBotInferenceMessage[] = [];
      const before = await tail().catch(() => none);
      await Effect.runPromise(sendGrokBotPrompt(store, { agentId: thread.id, prompt, clientNonce: turn.id }, options));
      const started = Date.now();
      const timeoutMs = this.#options.gatewayTurnTimeoutMs ?? 10 * 60_000;
      const pollMs = this.#options.gatewayPollMs ?? 1500;
      let stable = 0;
      let lastSeen = "";
      while (Date.now() - started < timeoutMs) {
        await sleep(pollMs, turn.controller.signal);
        if (thread.turn?.id !== turn.id) return;
        const messages = await tail().catch(() => null);
        if (!messages) continue;
        const reply = replyAfter(before, messages, prompt);
        if (reply.length > turn.text.length && reply.startsWith(turn.text)) {
          const delta = reply.slice(turn.text.length);
          turn.text = reply;
          this.#emit("item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId: turn.itemId, delta });
        } else if (reply !== turn.text && reply.length > 0) {
          turn.text = reply;
        }
        stable = reply.length > 0 && reply === lastSeen ? stable + 1 : 0;
        lastSeen = reply;
        if (stable >= 2) break;
      }
      if (thread.turn?.id !== turn.id) return;
      if (turn.text.length === 0) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
      thread.messages = [...thread.messages, { role: "USER", text: prompt }, { role: "ASSISTANT", text: turn.text }];
      this.#emit("item/completed", {
        threadId: thread.id,
        turnId: turn.id,
        item: { type: "agentMessage", id: turn.itemId, text: turn.text, status: "completed" },
      });
      thread.turn = null;
      this.#emit("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "completed" } });
    } catch (error) {
      if (thread.turn?.id !== turn.id) return;
      thread.turn = null;
      if (turn.controller.signal.aborted) {
        this.#emit("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "interrupted" } });
        return;
      }
      const message = error instanceof Error ? error.message : sourceText("error.provider.grokBotTurnFailed");
      this.emit("diagnostic", `Grok Bot turn failed: ${message}`);
      this.#emit("error", { threadId: thread.id, turnId: turn.id, message });
      this.#emit("turn/completed", {
        threadId: thread.id,
        turn: { id: turn.id, status: "failed", error: { message } },
      });
    }
  }

  #interrupt(params: unknown): { turn: { id: string; status: string } } | Record<string, never> {
    const threadId = isRecord(params) ? getString(params, "threadId") : null;
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    const turn = thread?.turn;
    if (!thread || !turn) return {};
    turn.controller.abort();
    return { turn: { id: turn.id, status: "interrupted" } };
  }

  async #machine(): Promise<string> {
    if (this.#options.machineId) return this.#options.machineId;
    if (this.#machineId) return this.#machineId;
    if (this.#options.machineIdPath) {
      this.#machineId = await readOrCreateMachineId(this.#options.machineIdPath);
      return this.#machineId;
    }
    this.#machineId = randomUUID();
    return this.#machineId;
  }

  async #runTool(thread: SandThread, turnId: string, call: GrokBotStreamTool): Promise<GrokBotToolResultPart> {
    const parsed = parseToolArgs(call.args);
    const names = splitToolName(call.toolName, thread.tools);
    this.#emitTool(thread, turnId, call, "inProgress");
    const result = await Effect.runPromise(
      this.#requests.call(
        "item/tool/call",
        {
          threadId: thread.id,
          turnId,
          callId: call.toolCallId,
          namespace: names.namespace,
          tool: names.tool,
          arguments: parsed,
        },
        thread.turn?.controller.signal,
      ),
    );
    const toolResult = toolResultPart(call, result);
    this.#emit("item/completed", {
      threadId: thread.id,
      turnId,
      item: {
        id: call.toolCallId,
        type: "dynamicToolCall",
        namespace: names.namespace,
        tool: names.tool,
        arguments: parsed,
        status: toolResult.isError ? "failed" : "completed",
        contentItems: [
          { type: "inputText", text: toolResult.text },
          ...toolResult.images.map((image) => ({ type: "inputImage", imageUrl: image.data })),
        ],
      },
    });
    return toolResult;
  }

  #emitTool(thread: SandThread, turnId: string, call: GrokBotStreamTool, status: string): void {
    const names = splitToolName(call.toolName, thread.tools);
    this.#emit("item/started", {
      threadId: thread.id,
      turnId,
      item: {
        id: call.toolCallId,
        type: "dynamicToolCall",
        namespace: names.namespace,
        tool: names.tool,
        arguments: parseToolArgs(call.args),
        status,
      },
    });
  }

  #emit(method: string, params: unknown): void {
    this.emit("notification", { method, params });
  }

  #apiBase(): string {
    return (this.#options.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/u, "");
  }

  #callOptions(): { apiBaseUrl: string; fetchImpl?: typeof fetch } {
    return {
      apiBaseUrl: this.#apiBase(),
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
    };
  }
}

function requiredId(params: unknown, key: string): string {
  const value = isRecord(params) ? getString(params, key) : null;
  if (!value) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
  return value;
}

function hasPrompt(params: unknown): boolean {
  return inputItems(params).some(
    (item) =>
      (item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0) ||
      (item.type === "localImage" && typeof item.path === "string") ||
      (item.type === "mention" && typeof item.path === "string"),
  );
}

function inputItems(params: unknown): DynamicRecord[] {
  if (!isDynamicRecord(params) || !Array.isArray(params.input)) return [];
  return params.input.filter(isDynamicRecord);
}

async function userMessage(params: unknown): Promise<GrokBotInferenceMessage> {
  const parts: Array<GrokBotTextPart | GrokBotImagePart> = [];
  for (const item of inputItems(params)) {
    if (item.type === "text" && typeof item.text === "string") parts.push({ type: "text", text: item.text });
    if (item.type === "mention" && typeof item.path === "string") {
      parts.push({ type: "text", text: `Attached local file: ${item.path}` });
    }
    if (item.type === "localImage" && typeof item.path === "string") parts.push(await imageFromPath(item.path));
  }
  if (!parts.some((part) => part.type === "image")) {
    return {
      role: "USER",
      text: parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim(),
    };
  }
  return { role: "USER", parts };
}

async function imageFromPath(path: string): Promise<GrokBotTextPart | GrokBotImagePart> {
  const bytes = await readFile(path);
  const mimeType = attachmentMimeTypeForName(path);
  if (bytes.length > GROK_BOT_MAX_IMAGE_BYTES) {
    return { type: "text", text: `[image omitted: failed to process ${bytes.length} bytes (${mimeType})]` };
  }
  return { type: "image", data: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType };
}

function advertisedTools(value: unknown): GrokBotAdvertisedTool[] {
  if (!Array.isArray(value)) return [];
  const tools: GrokBotAdvertisedTool[] = [];
  for (const namespace of value) {
    if (!isDynamicRecord(namespace) || typeof namespace.name !== "string" || !Array.isArray(namespace.tools)) continue;
    for (const tool of namespace.tools) {
      if (!isDynamicRecord(tool) || typeof tool.name !== "string") continue;
      tools.push({
        name: `${namespace.name}.${tool.name}`,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: isDynamicRecord(tool.inputSchema) ? tool.inputSchema : { type: "object" },
      });
    }
  }
  return tools;
}

function splitToolName(
  name: string,
  tools: readonly GrokBotAdvertisedTool[],
): { namespace: string | null; tool: string } {
  const source = tools.find((tool) => tool.name === name)?.name ?? name;
  const dot = source.indexOf(".");
  if (dot <= 0) return { namespace: null, tool: source };
  return { namespace: source.slice(0, dot), tool: source.slice(dot + 1) };
}

function parseToolArgs(raw: string): DynamicRecord {
  try {
    const parsed = JSON.parse(raw);
    if (isDynamicRecord(parsed)) return parsed;
  } catch {
    return {};
  }
  return {};
}

function toolCallRecord(call: GrokBotStreamTool): GrokBotToolCall {
  return { toolCallId: call.toolCallId, toolName: call.toolName, args: parseToolArgs(call.args), rawArgs: call.args };
}

function toolResultPart(call: GrokBotStreamTool, result: unknown): GrokBotToolResultPart {
  if (!isToolResult(result)) {
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      text: sourceText("error.provider.grokBotTurnFailed"),
      isError: true,
      images: [],
    };
  }
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    text: result.contentItems.flatMap((item) => (item.type === "inputText" ? [item.text] : [])).join("\n"),
    isError: !result.success,
    images: result.contentItems.flatMap((item) => (item.type === "inputImage" ? [imagePart(item.imageUrl)] : [])),
  };
}

function imagePart(imageUrl: string): GrokBotImagePart {
  const mimeType = imageUrl.startsWith("data:")
    ? (imageUrl.slice(5).split(";")[0] ?? "application/octet-stream")
    : "image/png";
  return { type: "image", data: imageUrl, mimeType };
}

function isToolResult(value: unknown): value is DynamicToolResult {
  return (
    isRecord(value) &&
    typeof value.success === "boolean" &&
    Array.isArray(value.contentItems) &&
    value.contentItems.every(
      (item) =>
        isRecord(item) &&
        ((item.type === "inputText" && typeof item.text === "string") ||
          (item.type === "inputImage" && typeof item.imageUrl === "string")),
    )
  );
}

function isUnauthenticated(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /unauthenticated|HTTP 401/iu.test(text);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Text of the user's prompt from `turn/start` params (`input` text items). */
function promptText(params: unknown): string {
  const parts: string[] = [];
  for (const item of inputItems(params)) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    if (item.type === "mention" && typeof item.path === "string") parts.push(`Attached local file: ${item.path}`);
  }
  const text = parts.join("\n").trim();
  if (text.length === 0) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
  return text;
}

/** Assistant text written after our prompt in the transcript tail. */
export function replyAfter(
  before: readonly GrokBotInferenceMessage[],
  after: readonly GrokBotInferenceMessage[],
  prompt: string,
): string {
  let start = -1;
  for (let index = after.length - 1; index >= Math.min(before.length, after.length) - 1 && index >= 0; index -= 1) {
    const message = after[index];
    if (message && message.role === "USER" && "text" in message && message.text.trim() === prompt.trim()) {
      start = index;
      break;
    }
  }
  if (start < 0) return "";
  return after
    .slice(start + 1)
    .filter((message) => message.role === "ASSISTANT" && "text" in message)
    .map((message) => ("text" in message ? message.text : ""))
    .join("\n\n");
}
