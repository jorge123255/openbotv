import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { GrokBotInferenceMessage } from "./grok-bot-inference";

/**
 * BotAI transcript ids (`transcript-entry-ids.ts`): `t<n>u` is a user message and `t<turn>a<n>` is
 * an assistant message. `kind: "message"` also carries `role`. `send-message` cards stay out.
 */
export function transcriptToMessages(body: unknown): GrokBotInferenceMessage[] {
  const entries = Array.isArray(body) ? body : isDynamicRecord(body) && Array.isArray(body.entries) ? body.entries : [];
  const messages: GrokBotInferenceMessage[] = [];
  for (const entry of entries) {
    if (!isDynamicRecord(entry)) continue;
    const role = transcriptRole(entry);
    const text = transcriptText(entry);
    if (!role || text.length === 0) continue;
    messages.push({ role, text });
  }
  return messages;
}

function transcriptRole(entry: DynamicRecord): "USER" | "ASSISTANT" | null {
  const role = typeof entry.role === "string" ? entry.role : "";
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  if (role === "user" || kind === "user-message" || (kind === "message" && role === "user")) return "USER";
  if (role === "assistant" || kind === "assistant-message" || (kind === "message" && role === "assistant"))
    return "ASSISTANT";
  const id = typeof entry.id === "string" ? entry.id : "";
  if (/^t\d+u$/u.test(id)) return "USER";
  if (/^t\d+a\d+$/u.test(id)) return "ASSISTANT";
  return null;
}

function transcriptText(entry: DynamicRecord): string {
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.content === "string") return entry.content;
  const message = isDynamicRecord(entry.message) ? entry.message : null;
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string" && (message.type === "text" || message.type === undefined))
    return message.content;
  return "";
}
