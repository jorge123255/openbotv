import type { ConnectKimiCliUsageInput } from "@openbot/contracts/ipc";
import { isObject, requireString } from "./validation";

export function parseKimiCliUsageConsent(value: unknown): { allowRefresh: true } {
  if (!isObject(value) || value.allowRefresh !== true) throw new Error("Usage refresh consent is required.");
  return { allowRefresh: true };
}
export function parseKimiCliUsageConnection(value: unknown): ConnectKimiCliUsageInput {
  parseKimiCliUsageConsent(value);
  if (
    !isObject(value) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  )
    throw new Error("Invalid local usage port.");
  const token = requireString(value.token, "token", 4_096);
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("Invalid local usage token.");
  return { port: value.port, token, allowRefresh: true };
}
