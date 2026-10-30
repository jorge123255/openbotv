import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { GROK_BOT_CURSOR_CLIENT_VERSION } from "./grok-bot-gateway";

/**
 * BotAI sends a turn with `InferenceService.Stream` (`aiserver.v1.InferenceService`) and the sand
 * access token. The JSON fields match `buildStreamRequest` in
 * `source/packages/chat-inference-proto/converters.ts`. A text part with `isFinal` is the end of
 * the part and carries no extra text, as `ProtoPromptExecutor.protoResponseToStreamParts` does.
 *
 * Headers match `createSandInferenceInterceptor` in
 * `source/shared/node/cursor-backend/cursor-inference.ts`, except `x-cursor-checksum`. BotAI builds
 * that header from a machine id this process does not have. A live Stream call may refuse the
 * request until that id is copied. Do not invent one.
 *
 * A compressed Connect frame (flag bit 0) is refused. BotAI's Connect transport can compress; this
 * client does not.
 */
export const GROK_BOT_MODEL_ID = "default";

export interface GrokBotInferenceMessage {
  readonly role: "SYSTEM" | "USER" | "ASSISTANT";
  readonly text: string;
}

export interface GrokBotStreamText {
  readonly kind: "text" | "thinking";
  readonly text: string;
}

export interface GrokBotStreamTool {
  readonly kind: "tool";
  readonly name: string;
}

export type GrokBotStreamEvent = GrokBotStreamText | GrokBotStreamTool;

export interface GrokBotStreamRequest {
  readonly messages: readonly GrokBotInferenceMessage[];
  readonly tools: readonly [];
  readonly providerDefinedTools: readonly [];
  readonly acceptedUnadvertisedToolNames: readonly [];
  readonly requestedModel: { readonly modelId: string; readonly maxMode: false; readonly parameters: readonly [] };
  readonly conversationId: string;
  readonly invocationId: string;
}

export function grokBotStreamBody(input: {
  readonly messages: readonly GrokBotInferenceMessage[];
  readonly modelId: string;
  readonly conversationId: string;
  readonly invocationId: string;
}): GrokBotStreamRequest {
  return {
    messages: input.messages,
    tools: [],
    providerDefinedTools: [],
    acceptedUnadvertisedToolNames: [],
    requestedModel: { modelId: input.modelId, maxMode: false, parameters: [] },
    conversationId: input.conversationId,
    invocationId: input.invocationId,
  };
}

export async function readGrokBotInference(input: {
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  readonly body: GrokBotStreamRequest;
  readonly signal: AbortSignal;
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
      "Content-Type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "sand",
      "x-cursor-client-version": GROK_BOT_CURSOR_CLIENT_VERSION,
      "x-sand-box-namespace": "prod",
      "x-ghost-mode": "true",
    },
    body: JSON.stringify(input.body),
  });
  if (!response.ok || !response.body) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
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
    throw new Error(sourceText("error.provider.grokBotTurnFailed"));
  }
  if (isDynamicRecord(message.toolCallPart)) {
    const name = typeof message.toolCallPart.toolName === "string" ? message.toolCallPart.toolName : "";
    onEvent({ kind: "tool", name });
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
      if (isDynamicRecord(json) && json.error != null) throw new Error(sourceText("error.provider.grokBotTurnFailed"));
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
