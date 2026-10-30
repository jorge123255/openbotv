import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** BotAI stores this id under the secret key `cursor-machine-id`. The value is a UUID, not an access token. */
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * BotAI `enhancedObfuscate` in `source/shared/node/cursor-backend/cursor-inference.ts`.
 * It mutates `bytes`.
 */
function enhancedObfuscate(bytes: Uint8Array): Uint8Array {
  let lastByte = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    const current = bytes[index] ?? 0;
    bytes[index] = ((current ^ lastByte) + (index % 256)) & 255;
    lastByte = bytes[index] ?? 0;
  }
  return bytes;
}

/** BotAI `createCursorChecksum`. The header value is this string plus the machine id. */
export function createCursorChecksum(machineId: string, nowMs = Date.now()): string {
  const unixKiloSeconds = Math.floor(nowMs / 1_000_000);
  const bytes = new Uint8Array([
    (unixKiloSeconds >> 40) & 255,
    (unixKiloSeconds >> 32) & 255,
    (unixKiloSeconds >> 24) & 255,
    (unixKiloSeconds >> 16) & 255,
    (unixKiloSeconds >> 8) & 255,
    unixKiloSeconds & 255,
  ]);
  return `${Buffer.from(enhancedObfuscate(bytes)).toString("base64url")}${machineId}`;
}

/**
 * The same persistence as BotAI `getOrCreateMachineId`: one UUID, kept, and reused.
 * OpenBot stores it in a file. It does not use the Cursor CLI keychain item.
 */
export async function readOrCreateMachineId(path: string, createId: () => string = randomUUID): Promise<string> {
  const existing = await readFile(path, "utf8")
    .then((text) => text.trim())
    .catch(() => "");
  if (MACHINE_ID.test(existing)) return existing;
  const created = createId();
  if (!MACHINE_ID.test(created)) throw new Error("The machine id is not a UUID.");
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${created}\n`, { flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const raced = (await readFile(path, "utf8")).trim();
    if (MACHINE_ID.test(raced)) return raced;
    throw error;
  }
}
