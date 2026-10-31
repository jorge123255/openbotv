import type { HermesGatewaySetup } from "@openbot/contracts/ipc";
import { decodeRecord, requiredBoolean } from "@openbot/contracts/ipc-decoding";
import { isOneOf } from "@openbot/contracts/runtime-values";

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid Hermes gateway text.");
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid Hermes gateway list.");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value, 256);
}

/** Separate from main's gateway decoder: only this small credential-free projection reaches UI. */
export function decodeHermesGatewaySetups(value: unknown): HermesGatewaySetup[] {
  return list(value, 8).map((item) => {
    const entry = decodeRecord(item, "Hermes gateway");
    const address = text(entry.url, 2_048);
    const url = new URL(address);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol))
      throw new Error("Invalid Hermes gateway address.");
    if (!isOneOf(["discovered", "signing-in", "connected", "signed-out"] as const, entry.phase))
      throw new Error("Invalid Hermes gateway phase.");
    if (entry.expiresAt !== null && (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)))
      throw new Error("Invalid Hermes gateway expiry.");
    return {
      id: text(entry.id, 36),
      url: address,
      phase: entry.phase,
      remembered: requiredBoolean(entry, "remembered"),
      selectedProfileId: nullableText(entry.selectedProfileId),
      expiresAt: entry.expiresAt,
      providers: list(entry.providers, 32).map((value) => {
        const provider = decodeRecord(value, "Hermes provider");
        return {
          id: text(provider.id, 256),
          name: text(provider.name, 256),
          supported: requiredBoolean(provider, "supported"),
        };
      }),
      profiles: list(entry.profiles, 1_000).map((value) => {
        const profile = decodeRecord(value, "Hermes profile");
        return { id: text(profile.id, 256), name: text(profile.name, 256) };
      }),
    };
  });
}
