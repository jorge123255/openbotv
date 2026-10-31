// Synthetic fixtures only. No credential stores, key export, logging or file access.
import { Effect, Schema } from "effect";
import { base64url, CompactEncrypt, compactDecrypt, generateSecret } from "jose";

export type FixtureEnvelopePurpose = "source" | "transfer" | "destination";

export class FixtureEnvelopeFailure extends Schema.TaggedError<FixtureEnvelopeFailure>()("FixtureEnvelopeFailure", {
  code: Schema.Literals(["ENVELOPE_REJECTED", "FIXTURE_CRYPTO_FAILED"]),
}) {}

const MAX_PLAINTEXT_BYTES = 16 * 1024;
const MAX_WIRE_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_CHARACTERS = Math.ceil((MAX_PLAINTEXT_BYTES * 4) / 3);

function fixedHeader(purpose: FixtureEnvelopePurpose) {
  if (purpose !== "source" && purpose !== "transfer" && purpose !== "destination") {
    throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  }
  return {
    alg: "dir",
    enc: "A256GCM",
    typ: `openbot-synthetic-credentials-${purpose}+jwe`,
    cty: "application/octet-stream",
  };
}

function canonicalSegment(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  const bytes = base64url.decode(value);
  if (base64url.encode(bytes) !== value) throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  return bytes;
}

function checkToken(token: string, purpose: FixtureEnvelopePurpose): void {
  if (typeof token !== "string" || token.length > MAX_WIRE_BYTES) {
    throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  }
  const segments = token.split(".");
  const [header, encryptedKey, iv, ciphertext, tag] = segments;
  if (
    segments.length !== 5 ||
    header !== base64url.encode(JSON.stringify(fixedHeader(purpose))) ||
    encryptedKey !== "" ||
    iv === undefined ||
    iv.length !== 16 ||
    ciphertext === undefined ||
    ciphertext.length > MAX_CIPHERTEXT_CHARACTERS ||
    tag === undefined ||
    tag.length !== 22
  ) {
    throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  }
  if (
    canonicalSegment(iv).byteLength !== 12 ||
    canonicalSegment(tag).byteLength !== 16 ||
    canonicalSegment(ciphertext).byteLength > MAX_PLAINTEXT_BYTES
  ) {
    throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  }
}

/** Creates a random, nonextractable AES-256 key that stays separate from fixture payloads. */
export const newFixtureKey = Effect.fn("FixtureEnvelope.newKey")(function* () {
  return yield* Effect.tryPromise({
    try: () => generateSecret("A256GCM"),
    catch: () => new FixtureEnvelopeFailure({ code: "FIXTURE_CRYPTO_FAILED" }),
  });
});

/** Encrypts bounded fixture bytes. The library owns IV generation and authenticated encryption. */
export const sealFixtureBytes = Effect.fn("FixtureEnvelope.seal")(function* (
  bytes: Uint8Array,
  key: CryptoKey,
  purpose: FixtureEnvelopePurpose,
) {
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PLAINTEXT_BYTES)
          throw new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
        return { plaintext: new Uint8Array(bytes), header: fixedHeader(purpose) };
      },
      catch: () => new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" }),
    }),
    (input) =>
      Effect.gen(function* () {
        const token = yield* Effect.tryPromise({
          try: () => new CompactEncrypt(input.plaintext).setProtectedHeader(input.header).encrypt(key),
          catch: () => new FixtureEnvelopeFailure({ code: "FIXTURE_CRYPTO_FAILED" }),
        });
        return yield* Effect.try({
          try: () => {
            checkToken(token, purpose);
            return token;
          },
          catch: () => new FixtureEnvelopeFailure({ code: "FIXTURE_CRYPTO_FAILED" }),
        });
      }),
    (input) =>
      Effect.sync(() => {
        input.plaintext.fill(0);
      }),
  );
});

/** Authenticates bounded fixture bytes; callers must validate all decrypted identity bindings. */
export const openFixtureBytes = Effect.fn("FixtureEnvelope.open")(function* (
  token: string,
  key: CryptoKey,
  purpose: FixtureEnvelopePurpose,
) {
  yield* Effect.try({
    try: () => checkToken(token, purpose),
    catch: () => new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" }),
  });
  const result = yield* Effect.tryPromise({
    try: () =>
      compactDecrypt(token, key, {
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
        maxDecompressedLength: 0,
      }),
    catch: () => new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" }),
  });
  if (result.plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    return yield* new FixtureEnvelopeFailure({ code: "ENVELOPE_REJECTED" });
  }
  return result.plaintext;
});
