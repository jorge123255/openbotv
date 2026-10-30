import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { createCursorChecksum } from "./grok-bot-checksum";
import { GROK_BOT_CURSOR_CLIENT_VERSION } from "./grok-bot-gateway";

/**
 * BotAI sends a turn with `InferenceService.Stream` (`aiserver.v1.InferenceService`) and the sand
 * access token. The JSON fields match `buildStreamRequest` in
 * `source/packages/chat-inference-proto/converters.ts`. A text part with `isFinal` is the end of
 * the part and carries no extra text, as `ProtoPromptExecutor.protoResponseToStreamParts` does.
 *
 * Headers match `createSandInferenceInterceptor` in
 * `source/shared/node/cursor-backend/cursor-inference.ts`, including `x-cursor-checksum` from
 * `createCursorChecksum`.
 *
 * A compressed Connect frame (flag bit 0) is refused. BotAI's Connect transport can compress; this
 * client does not.
 */
export const GROK_BOT_MODEL_ID = "default";

export const GROK_BOT_MAX_IMAGE_BYTES = 1024 * 1024;

export interface GrokBotTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface GrokBotImagePart {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface GrokBotToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: DynamicRecord;
  readonly rawArgs: string;
}

export interface GrokBotToolResultPart {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly text: string;
  readonly isError: boolean;
  readonly images: readonly GrokBotImagePart[];
}

export type GrokBotInferenceMessage =
  | { readonly role: "SYSTEM" | "USER" | "ASSISTANT"; readonly text: string }
  | { readonly role: "USER"; readonly parts: readonly (GrokBotTextPart | GrokBotImagePart)[] }
  | { readonly role: "ASSISTANT"; readonly text: string; readonly toolCalls: readonly GrokBotToolCall[] }
  | { readonly role: "TOOL"; readonly results: readonly GrokBotToolResultPart[] };

export interface GrokBotAdvertisedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: DynamicRecord;
}

interface GrokBotStreamText {
  readonly kind: "text" | "thinking";
  readonly text: string;
}

export interface GrokBotStreamTool {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: string;
  readonly isComplete: boolean;
}

export type GrokBotStreamEvent = GrokBotStreamText | GrokBotStreamTool;

export interface GrokBotStreamRequest {
  readonly messages: readonly ReturnType<typeof wireMessage>[];
  readonly tools: readonly GrokBotAdvertisedTool[];
  readonly providerDefinedTools: readonly [];
  readonly acceptedUnadvertisedToolNames: readonly [];
  readonly requestedModel: { readonly modelId: string; readonly maxMode: false; readonly parameters: readonly [] };
  readonly conversationId: string;
  readonly invocationId: string;
}

export function grokBotStreamBody(input: {
  readonly messages: readonly GrokBotInferenceMessage[];
  readonly tools?: readonly GrokBotAdvertisedTool[];
  readonly modelId: string;
  readonly conversationId: string;
  readonly invocationId: string;
}): GrokBotStreamRequest {
  return {
    messages: input.messages.map(wireMessage),
    tools: input.tools ?? [],
    providerDefinedTools: [],
    acceptedUnadvertisedToolNames: [],
    requestedModel: { modelId: input.modelId, maxMode: false, parameters: [] },
    conversationId: input.conversationId,
    invocationId: input.invocationId,
  };
}

function wireMessage(message: GrokBotInferenceMessage) {
  if ("results" in message) {
    return {
      role: "TOOL" as const,
      toolContent: {
        parts: message.results.map((result) => ({
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result: result.text,
          ...(result.isError ? { isError: true } : {}),
          ...(result.images.length > 0
            ? {
                experimentalContent: result.images.map((image) => ({
                  image: { data: image.data, mimeType: image.mimeType },
                })),
              }
            : {}),
        })),
      },
    };
  }
  if ("toolCalls" in message) {
    return {
      role: "ASSISTANT" as const,
      ...(message.text.length > 0 ? { text: message.text } : {}),
      toolCalls: message.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
        rawToolCallArgs: call.rawArgs,
      })),
    };
  }
  if ("parts" in message) {
    return {
      role: "USER" as const,
      parts: {
        parts: message.parts.map((part) =>
          part.type === "text"
            ? { text: { text: part.text } }
            : { image: { data: part.data, mimeType: part.mimeType } },
        ),
      },
    };
  }
  return { role: message.role, text: message.text };
}

export async function readGrokBotInference(input: {
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  readonly body: GrokBotStreamRequest;
  readonly signal: AbortSignal;
  readonly machineId: string;
  readonly checksumNow?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly onEvent: (event: GrokBotStreamEvent) => void;
}): Promise<void> {
  registerSecretValue(input.accessToken);
  const call = input.fetchImpl ?? fetch;
  const response = await call(new URL("/aiserver.v1.InferenceService/Stream", input.apiBaseUrl), {
    method: "POST",
    redirect: "manual",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/connect+json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "sand",
      "x-cursor-client-version": GROK_BOT_CURSOR_CLIENT_VERSION,
      "x-sand-box-namespace": "prod",
      "x-ghost-mode": "true",
      "x-cursor-checksum": createCursorChecksum(input.machineId, input.checksumNow?.() ?? Date.now()),
    },
    body: encodeConnectEnvelope(input.body),
  });
  if (!response.ok || !response.body) {
    const detail = response.ok
      ? "empty body"
      : `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`;
    throw new Error(`${sourceText("error.provider.grokBotTurnFailed")} (${detail.trim()})`);
  }
  const reader = response.body.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      pending = concatBytes(pending, next.value);
      const parsed = takeConnectMessages(pending);
      pending = parsed.rest;
      for (const message of parsed.messages) emitStreamMessage(message, input.onEvent);
    }
  } finally {
    reader.releaseLock();
  }
}

function emitStreamMessage(message: unknown, onEvent: (event: GrokBotStreamEvent) => void): void {
  if (!isDynamicRecord(message)) return;
  if (isDynamicRecord(message.error)) {
    throw new Error(`${sourceText("error.provider.grokBotTurnFailed")} (${connectErrorText(message.error)})`);
  }
  if (isDynamicRecord(message.toolCallPart)) {
    const part = message.toolCallPart;
    const toolName = typeof part.toolName === "string" ? part.toolName : "";
    const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
    const args = typeof part.args === "string" ? part.args : "";
    if (toolCallId.length === 0) return;
    onEvent({ kind: "tool", toolCallId, toolName, args, isComplete: part.isComplete === true });
    return;
  }
  const thinking = isDynamicRecord(message.thinkingPart) ? message.thinkingPart : null;
  if (thinking && typeof thinking.text === "string" && thinking.text.length > 0) {
    onEvent({ kind: "thinking", text: thinking.text });
  }
  const text = isDynamicRecord(message.textPart) ? message.textPart : null;
  if (!text || text.isFinal === true) return;
  if (typeof text.text === "string" && text.text.length > 0) onEvent({ kind: "text", text: text.text });
}

function takeConnectMessages(bytes: Uint8Array<ArrayBufferLike>): {
  messages: unknown[];
  rest: Uint8Array<ArrayBufferLike>;
} {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset] ?? 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4);
    const length = view.getUint32(0);
    if (offset + 5 + length > bytes.length) break;
    if ((flags & 0x01) !== 0) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
    const payload = bytes.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    const text = new TextDecoder().decode(payload);
    const json = text.length === 0 ? {} : JSON.parse(text);
    if ((flags & 0x02) !== 0) {
      if (isDynamicRecord(json) && json.error != null) {
        throw new Error(`${sourceText("error.provider.grokBotTurnFailed")} (${connectErrorText(json.error)})`);
      }
      return { messages, rest: new Uint8Array(0) };
    }
    messages.push(json);
  }
  return { messages, rest: bytes.subarray(offset) };
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) return right;
  const next = new Uint8Array(left.length + right.length);
  next.set(left);
  next.set(right, left.length);
  return next;
}

function connectErrorText(error: unknown): string {
  if (!isDynamicRecord(error)) return String(error);
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (
    [code, message]
      .filter((part) => part.length > 0)
      .join(": ")
      .slice(0, 300) || "stream error"
  );
}

/** Connect server-streaming requires an enveloped body: 1 flag byte + 4-byte BE length + JSON. */
export function encodeConnectEnvelope(message: unknown): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}
