import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { Effect, Schema } from "effect";

const FIXTURE_ROOT_SHA256 = "ffedc2c317fedb9ea6ae8a054c7777f97042e362d745035918f9ba3b30d2038c";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export class OfflineProvenanceFailure extends Schema.TaggedError<OfflineProvenanceFailure>()(
  "OfflineProvenanceFailure",
  {
    code: Schema.Literals([
      "invalid-input",
      "root-pin-mismatch",
      "unsupported-bundle",
      "verification-failed",
      "identity-mismatch",
    ]),
  },
) {}

interface OfflineSignatureInput {
  root: Uint8Array;
  bundle: Uint8Array;
  /** Mandatory for message signatures; must be null for DSSE. DSSE does not bind an external artifact. */
  artifact: Uint8Array | null;
  expectedSigner: { issuer: string; subjectAlternativeName: string };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalid(): never {
  throw new OfflineProvenanceFailure({ code: "invalid-input" });
}

function copy(bytes: Uint8Array, limit: number): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer || bytes.byteLength > limit)
    invalid();
  return Buffer.from(bytes);
}

function bound(value: unknown, depth = 0): void {
  if (depth > 24) invalid();
  if (typeof value === "string" && value.length > 64 * 1024) invalid();
  if (Array.isArray(value)) {
    if (value.length > 64) invalid();
    for (const item of value) bound(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 64) invalid();
    for (const [key, item] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") invalid();
      bound(item, depth + 1);
    }
  }
}

/** Canonical admission rejects duplicate keys, ambiguous encodings and extra whitespace. No normalization of signed bytes. */
function json(bytes: Uint8Array): Schema.Json {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const value = JSON.parse(body);
  if (JSON.stringify(value) !== body) invalid();
  bound(value);
  return Schema.decodeUnknownSync(Schema.Json)(value);
}

/**
 * Isolated signature primitive, pinned to public upstream test roots only.
 * No production root, network, credential, IPC, release admission or destination capability.
 * Synchronous SDK work is bounded but cannot be interrupted by Effect. Run in a killable
 * process before accepting live untrusted input. This service is not wired into the app.
 */
export class OfflineProvenanceFixtureVerifier {
  readonly verify = Effect.fn("OfflineProvenanceFixtureVerifier.verify")((input: OfflineSignatureInput) =>
    Effect.try({
      try: () => {
        const rootBytes = copy(input.root, MAX_JSON_BYTES);
        const bundleBytes = copy(input.bundle, MAX_JSON_BYTES);
        const artifact = input.artifact === null ? null : copy(input.artifact, MAX_ARTIFACT_BYTES);
        const { issuer, subjectAlternativeName } = input.expectedSigner;
        if (
          typeof issuer !== "string" ||
          !issuer.length ||
          issuer.length > 2048 ||
          typeof subjectAlternativeName !== "string" ||
          !subjectAlternativeName.length ||
          subjectAlternativeName.length > 2048
        )
          invalid();
        if (sha256(rootBytes) !== FIXTURE_ROOT_SHA256)
          throw new OfflineProvenanceFailure({ code: "root-pin-mismatch" });
        const root = TrustedRoot.fromJSON(json(rootBytes));
        const bundleJson = json(bundleBytes);
        const bundle = bundleFromJSON(bundleJson);
        // Protobuf JSON conversion otherwise silently drops competing one-of fields and
        // ignores invalid base64 characters. Require its single, lossless representation.
        if (!isDeepStrictEqual(bundleJson, bundleToJSON(bundle))) invalid();
        if (
          bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" ||
          bundle.verificationMaterial.content.$case !== "certificate" ||
          bundle.verificationMaterial.tlogEntries.some((entry) => !entry.inclusionProof)
        )
          throw new OfflineProvenanceFailure({ code: "unsupported-bundle" });
        const kind = bundle.content.$case;
        if ((kind === "messageSignature") !== (artifact !== null))
          throw new OfflineProvenanceFailure({ code: "unsupported-bundle" });
        const signer = new Verifier(toTrustMaterial(root), {
          ctlogThreshold: 1,
          tlogThreshold: 1,
          timestampThreshold: 1,
        }).verify(toSignedEntity(bundle, artifact ?? undefined));
        // Compare exact strings after cryptographic verification. SDK string SAN policies are regexes.
        if (
          signer.identity?.extensions?.issuer !== issuer ||
          signer.identity?.subjectAlternativeName !== subjectAlternativeName
        )
          throw new OfflineProvenanceFailure({ code: "identity-mismatch" });
        return Object.freeze({
          scope: "public-fixture-only" as const,
          kind,
          rootSha256: sha256(rootBytes),
          bundleSha256: sha256(bundleBytes),
          artifactSha256: artifact === null ? null : sha256(artifact),
          signatureVerified: true as const,
          artifactBound: artifact !== null,
          productionTrusted: false as const,
          releaseApproved: false as const,
          runtimeVerified: false as const,
          destinationVerified: false as const,
          operations: Object.freeze({ export: false as const, restore: false as const, activate: false as const }),
        });
      },
      catch: (error) =>
        error instanceof OfflineProvenanceFailure
          ? error
          : new OfflineProvenanceFailure({ code: "verification-failed" }),
    }),
  );
}
