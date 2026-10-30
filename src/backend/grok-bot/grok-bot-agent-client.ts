import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentClient, DiagnosticOrigin } from "../agent-client";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder, RpcError } from "../protocol";
import { getString, isRecord } from "../protocol";
import { type ProviderClientOperationError, providerFailure } from "../provider-client-effects";
import type { GrokBotAccountStore } from "./grok-bot-account";
import { createGrokBotAgent, listGrokBotAgents } from "./grok-bot-gateway";
import {
  GROK_BOT_MODEL_ID,
  type GrokBotInferenceMessage,
  grokBotStreamBody,
  readGrokBotInference,
} from "./grok-bot-inference";
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
  turn: { id: string; itemId: string; text: string; controller: AbortController } | null;
}

export interface GrokBotAgentClientOptions {
  readonly store?: GrokBotAccountStore;
  readonly requestTimeoutMs?: number;
  readonly apiBaseUrl?: string;
  readonly allowLoopback?: boolean;
  readonly fetchImpl?: typeof fetch;
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
  readonly #threads = new Map<string, SandThread>();
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
    for (const thread of this.#threads.values()) thread.turn?.controller.abort();
    this.#threads.clear();
    return Effect.void;
  }

  notify(): void {
    /* OpenBot sends `initialized` after `initialize`. This client has nothing to start. */
  }

  respond(_id: RequestId, _result: unknown): void {
    /* This client does not ask the host to run a tool. */
  }

  respondError(_id: RequestId, _error: RpcError): void {
    /* This client does not ask the host to run a tool. */
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
    this.#threads.set(id, {
      id,
      instructions,
      messages: instructions ? [{ role: "SYSTEM", text: instructions }] : [],
      turn: null,
    });
    return { thread: { id } };
  });

  #startTurn(params: unknown): { turn: { id: string; status: string } } {
    const threadId = requiredId(params, "threadId");
    const thread = this.#threads.get(threadId);
    if (!thread) throw new Error("Grok Bot session not found");
    if (thread.turn) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
    const prompt = promptText(params);
    if (prompt.length === 0) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
    const model = isRecord(params) ? getString(params, "model") : null;
    const turnId = randomUUID();
    const controller = new AbortController();
    const itemId = `msg-${turnId}`;
    thread.turn = { id: turnId, itemId, text: "", controller };
    this.#emit("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    const messages = [...thread.messages, { role: "USER" as const, text: prompt }];
    void this.#stream(thread, messages, model && model.length > 0 ? model : GROK_BOT_MODEL_ID);
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async #stream(thread: SandThread, messages: GrokBotInferenceMessage[], modelId: string): Promise<void> {
    const turn = thread.turn;
    const store = this.#options.store;
    if (!turn || !store) return;
    try {
      const record = await Effect.runPromise(store.load());
      if (!record) throw new Error(sourceText("error.provider.grokBotNotSignedIn"));
      let sawTool = false;
      await readGrokBotInference({
        apiBaseUrl: this.#apiBase(),
        accessToken: record.accessToken,
        signal: turn.controller.signal,
        ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
        body: grokBotStreamBody({
          messages,
          modelId,
          conversationId: thread.id,
          invocationId: turn.id,
        }),
        onEvent: (event) => {
          if (thread.turn?.id !== turn.id) return;
          if (event.kind === "tool") {
            sawTool = true;
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
          turn.text += event.text;
          this.#emit("item/agentMessage/delta", {
            threadId: thread.id,
            turnId: turn.id,
            itemId: turn.itemId,
            delta: event.text,
          });
        },
      });
      if (thread.turn?.id !== turn.id) return;
      if (sawTool) throw new Error(sourceText("error.provider.grokBotToolUnsupported"));
      thread.messages = [...messages, { role: "ASSISTANT", text: turn.text }];
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

function promptText(params: unknown): string {
  if (!isDynamicRecord(params) || !Array.isArray(params.input)) return "";
  return params.input
    .filter(isDynamicRecord)
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n")
    .trim();
}
