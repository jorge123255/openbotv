// Test-only domain verifier. No application wiring, network adapter, filesystem or credential owner.
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { MIGRATION_PREPARATION_BLOCKERS } from "@openbot/contracts/ipc-migration-preparation";
import { remoteHostFingerprint } from "@openbot/team-client/host-key-handover";
import { Effect, Schema } from "effect";

const MAX_BODY = 32_768;
const MAX_ARTIFACT = 4_096;
const LIFETIME_MS = 60_000;
const DEADLINE_MS = 10_000;
const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,128}$/), Schema.isMaxLength(128));
const UUID = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
const HEX = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const FINGERPRINT = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
const SIGNATURE = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/));
const POSITIVE = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000_000));
const TIME = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const PEM = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ORIGIN = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const PLATFORM = Schema.Literals(["darwin", "linux", "win32"]);
const ARCHITECTURE = Schema.Literals(["arm64", "x64"]);

const Manifest = Schema.Struct({
  format: Schema.Literal("openbot-synthetic-artifact-v1"),
  artifactKind: Schema.Literals(["synthetic-package", "synthetic-image"]),
  platform: PLATFORM,
  architecture: ARCHITECTURE,
  runtime: Schema.Literals(["desktop", "server", "container"]),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_ARTIFACT)),
  sha256: HEX,
});
const Artifact = Schema.Struct({
  manifestJson: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  signature: SIGNATURE,
  bytesBase64Url: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(5_462)),
});
const Context = Schema.Struct({
  sourceHostId: ID,
  sourceOwnerApproved: Schema.Boolean,
  sourceRuntimeInstanceId: UUID,
  sourcePlatform: PLATFORM,
  sourceArchitecture: ARCHITECTURE,
  planId: UUID,
  preparationRevision: POSITIVE,
  preparationStatus: Schema.Literals(["prepared", "cancelled"]),
  assessmentId: UUID,
  assessmentRevision: POSITIVE,
  assessmentPlanId: UUID,
  assessmentPreparationRevision: POSITIVE,
  assessmentSha256: HEX,
  pairing: Schema.Struct({
    provenance: Schema.Literals(["independent-confirmation", "directory-only", "unapproved"]),
    sourceHostId: ID,
    destinationHostId: ID,
    publicKey: PEM,
    fingerprint: FINGERPRINT,
    origin: ORIGIN,
    installationId: UUID,
    runtimeInstanceId: UUID,
    destinationOwnerAdmin: Schema.Boolean,
  }),
  publisherApproved: Schema.Boolean,
  publisherPublicKey: PEM,
  sourceArtifact: Artifact,
});
const Request = Schema.Struct({
  format: Schema.Literal("openbot-synthetic-destination-request-v1"),
  requestId: UUID,
  challenge: FINGERPRINT,
  contextSha256: HEX,
  sourceHostId: ID,
  destinationHostId: ID,
  destinationFingerprint: FINGERPRINT,
  destinationOrigin: ORIGIN,
  installationId: UUID,
  runtimeInstanceId: UUID,
  publisherFingerprint: FINGERPRINT,
  sourceManifestSha256: HEX,
  planId: UUID,
  preparationRevision: POSITIVE,
  assessmentId: UUID,
  assessmentRevision: POSITIVE,
  assessmentSha256: HEX,
  issuedAtMs: TIME,
  expiresAtMs: TIME,
});
const Receipt = Schema.Struct({
  format: Schema.Literal("openbot-synthetic-destination-receipt-v1"),
  request: Request,
  issuedAtMs: TIME,
  expiresAtMs: TIME,
  artifact: Artifact,
  capabilities: Schema.Array(Schema.Literals(["migration-destination-synthetic-v1", "metadata-only"])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
  ),
});
const Envelope = Schema.Struct({ receipt: Receipt, signature: SIGNATURE });

export type SyntheticMigrationBuildManifest = typeof Manifest.Type;
export type SyntheticMigrationVerificationContext = typeof Context.Type;
export type SyntheticMigrationVerificationRequest = typeof Request.Type;
export type SyntheticMigrationVerificationReceipt = typeof Receipt.Type;

export class SyntheticMigrationVerificationFailure extends Schema.TaggedError<SyntheticMigrationVerificationFailure>()(
  "SyntheticMigrationVerificationFailure",
  {
    code: Schema.Literals([
      "unavailable",
      "busy",
      "attempt-limit",
      "unapproved",
      "invalid-context",
      "context-changed",
      "invalid-response",
      "transport-rejected",
      "signature-invalid",
      "build-unverified",
      "platform-incompatible",
      "build-mismatch",
      "capability-unavailable",
      "expired",
    ]),
  },
) {}
type Code = SyntheticMigrationVerificationFailure["code"];
function refuse(code: Code): never {
  throw new SyntheticMigrationVerificationFailure({ code });
}
function failure(error: unknown): SyntheticMigrationVerificationFailure {
  return error instanceof SyntheticMigrationVerificationFailure
    ? error
    : new SyntheticMigrationVerificationFailure({ code: "unavailable" });
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalKey(pem: string): void {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "pem" }).toString() !== pem)
    refuse("unapproved");
}
function exactOrigin(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.hash || url.search)
    refuse("unapproved");
}
function canonicalManifest(text: string): SyntheticMigrationBuildManifest {
  try {
    const value = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" })(JSON.parse(text));
    if (JSON.stringify(value) !== text) refuse("build-unverified");
    return value;
  } catch {
    return refuse("build-unverified");
  }
}

export function syntheticMigrationBuildStatement(manifestJson: string): string {
  return JSON.stringify(["openbot-synthetic-build-signature-v1", manifestJson]);
}
export function syntheticMigrationReceiptStatement(receipt: SyntheticMigrationVerificationReceipt): string {
  return JSON.stringify(["openbot-synthetic-destination-signature-v1", receipt]);
}
function verifyArtifact(artifact: typeof Artifact.Type, publisher: string) {
  const manifest = canonicalManifest(artifact.manifestJson);
  const bytes = Buffer.from(artifact.bytesBase64Url, "base64url");
  const signature = Buffer.from(artifact.signature, "base64url");
  if (
    bytes.length > MAX_ARTIFACT ||
    bytes.toString("base64url") !== artifact.bytesBase64Url ||
    signature.toString("base64url") !== artifact.signature ||
    bytes.length !== manifest.byteLength ||
    hash(bytes) !== manifest.sha256 ||
    !verify(null, Buffer.from(syntheticMigrationBuildStatement(artifact.manifestJson)), publisher, signature)
  )
    refuse("build-unverified");
  return { manifest, identity: hash(artifact.manifestJson) };
}

/** Envelope facts are synthetic adapter assertions, not observations of a real TLS connection. */
interface SyntheticEndpointObservation {
  origin: string;
  status: number;
  tls: "fixture-trusted" | "untrusted" | "hostname-mismatch" | "expired" | "unknown";
  redirected: boolean;
  body: Uint8Array;
}
interface SyntheticVerifierOptions {
  scope: "synthetic-only";
  readContext: () => Effect.Effect<SyntheticMigrationVerificationContext, SyntheticMigrationVerificationFailure>;
  observe: (
    request: SyntheticMigrationVerificationRequest,
    signal: AbortSignal,
  ) => Promise<SyntheticEndpointObservation>;
  wallClock: () => number;
  monotonicClock: () => number;
}

/** Never installed in application-services, IPC or any remote connection path. Receipts are not retained. */
export class SyntheticMigrationDestinationVerifier {
  readonly #options: SyntheticVerifierOptions;
  #active: symbol | null = null;
  #attempts = 0;
  constructor(options: SyntheticVerifierOptions) {
    this.#options = options;
  }

  readonly #context = Effect.fn("SyntheticDestination.context")(() =>
    Effect.gen({ self: this }, function* () {
      const input = yield* Effect.suspend(this.#options.readContext).pipe(
        Effect.mapError(() => new SyntheticMigrationVerificationFailure({ code: "invalid-context" })),
      );
      return yield* Effect.try({
        try: () => {
          // Serialize before handing any input to the endpoint; its mutable references cannot change this snapshot.
          const text = JSON.stringify(input);
          if (Buffer.byteLength(text) > MAX_BODY) refuse("invalid-context");
          const value = Schema.decodeUnknownSync(Context, { onExcessProperty: "error" })(JSON.parse(text));
          if (
            !value.sourceOwnerApproved ||
            !value.publisherApproved ||
            !value.pairing.destinationOwnerAdmin ||
            value.pairing.provenance !== "independent-confirmation" ||
            value.pairing.sourceHostId !== value.sourceHostId ||
            value.pairing.destinationHostId === value.sourceHostId
          )
            refuse("unapproved");
          if (
            value.preparationStatus !== "prepared" ||
            value.assessmentPlanId !== value.planId ||
            value.assessmentPreparationRevision !== value.preparationRevision
          )
            refuse("invalid-context");
          canonicalKey(value.pairing.publicKey);
          canonicalKey(value.publisherPublicKey);
          exactOrigin(value.pairing.origin);
          if (remoteHostFingerprint(value.pairing.publicKey) !== value.pairing.fingerprint) refuse("unapproved");
          return value;
        },
        catch: (error) =>
          error instanceof SyntheticMigrationVerificationFailure
            ? error
            : new SyntheticMigrationVerificationFailure({ code: "invalid-context" }),
      });
    }),
  );

  readonly verify = Effect.fn("SyntheticDestination.verify")(() =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          if (this.#active) refuse("busy");
          if (this.#attempts >= 32) refuse("attempt-limit");
          const attempt = Symbol();
          this.#active = attempt;
          this.#attempts++;
          return attempt;
        },
        catch: failure,
      }),
      (attempt) =>
        Effect.gen({ self: this }, function* () {
          const started = this.#options.monotonicClock();
          const wallStarted = this.#options.wallClock();
          if (!Number.isFinite(started) || started < 0 || !Number.isSafeInteger(wallStarted) || wallStarted < 0)
            return yield* new SyntheticMigrationVerificationFailure({ code: "expired" });
          if (this.#options.scope !== "synthetic-only")
            return yield* new SyntheticMigrationVerificationFailure({ code: "unapproved" });
          const context = yield* this.#context();
          const source = yield* Effect.try({
            try: () => verifyArtifact(context.sourceArtifact, context.publisherPublicKey),
            catch: failure,
          });
          if (
            source.manifest.platform !== context.sourcePlatform ||
            source.manifest.architecture !== context.sourceArchitecture
          )
            return yield* new SyntheticMigrationVerificationFailure({ code: "platform-incompatible" });
          const request = yield* Effect.try({
            try: () =>
              Schema.decodeUnknownSync(Request)({
                format: "openbot-synthetic-destination-request-v1",
                requestId: randomUUID(),
                challenge: randomBytes(32).toString("base64url"),
                contextSha256: hash(JSON.stringify(context)),
                sourceHostId: context.sourceHostId,
                destinationHostId: context.pairing.destinationHostId,
                destinationFingerprint: context.pairing.fingerprint,
                destinationOrigin: context.pairing.origin,
                installationId: context.pairing.installationId,
                runtimeInstanceId: context.pairing.runtimeInstanceId,
                publisherFingerprint: remoteHostFingerprint(context.publisherPublicKey),
                sourceManifestSha256: source.identity,
                planId: context.planId,
                preparationRevision: context.preparationRevision,
                assessmentId: context.assessmentId,
                assessmentRevision: context.assessmentRevision,
                assessmentSha256: context.assessmentSha256,
                issuedAtMs: wallStarted,
                expiresAtMs: wallStarted + LIFETIME_MS,
              }),
            catch: failure,
          });
          // Context/build work must not spend the local deadline and still call the endpoint.
          const beforeSend = this.#options.monotonicClock() - started;
          const beforeSendWall = this.#options.wallClock();
          if (
            !Number.isFinite(beforeSend) ||
            beforeSend < 0 ||
            beforeSend >= DEADLINE_MS ||
            !Number.isSafeInteger(beforeSendWall) ||
            beforeSendWall < wallStarted ||
            beforeSendWall >= request.expiresAtMs
          )
            return yield* new SyntheticMigrationVerificationFailure({ code: "expired" });
          const observation = yield* Effect.tryPromise({
            try: (signal) => this.#options.observe(Object.freeze({ ...request }), signal),
            catch: () => new SyntheticMigrationVerificationFailure({ code: "transport-rejected" }),
          });
          const envelope = yield* Effect.try({
            try: () => {
              if (
                observation.origin !== request.destinationOrigin ||
                observation.status !== 200 ||
                observation.redirected !== false ||
                observation.tls !== "fixture-trusted"
              )
                refuse("transport-rejected");
              if (!(observation.body instanceof Uint8Array) || observation.body.byteLength > MAX_BODY)
                refuse("invalid-response");
              const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                Buffer.from(observation.body),
              );
              const value = Schema.decodeUnknownSync(Envelope, { onExcessProperty: "error" })(JSON.parse(text));
              if (JSON.stringify(value) !== text || JSON.stringify(value.receipt.request) !== JSON.stringify(request))
                refuse("invalid-response");
              const signature = Buffer.from(value.signature, "base64url");
              if (
                signature.toString("base64url") !== value.signature ||
                !verify(
                  null,
                  Buffer.from(syntheticMigrationReceiptStatement(value.receipt)),
                  context.pairing.publicKey,
                  signature,
                )
              )
                refuse("signature-invalid");
              const capabilities = value.receipt.capabilities;
              if (
                !capabilities.includes("migration-destination-synthetic-v1") ||
                new Set(capabilities).size !== capabilities.length ||
                [...capabilities].sort().join() !== capabilities.join()
              )
                refuse("capability-unavailable");
              const destination = verifyArtifact(value.receipt.artifact, context.publisherPublicKey);
              if (
                source.manifest.platform !== destination.manifest.platform ||
                source.manifest.architecture !== destination.manifest.architecture ||
                source.manifest.runtime !== destination.manifest.runtime ||
                source.manifest.artifactKind !== destination.manifest.artifactKind
              )
                refuse("platform-incompatible");
              if (source.identity !== destination.identity) refuse("build-mismatch");
              return value;
            },
            catch: (error) =>
              error instanceof SyntheticMigrationVerificationFailure
                ? error
                : new SyntheticMigrationVerificationFailure({ code: "invalid-response" }),
          });
          const after = yield* this.#context();
          if (JSON.stringify(after) !== JSON.stringify(context))
            return yield* new SyntheticMigrationVerificationFailure({ code: "context-changed" });
          const now = this.#options.wallClock();
          const elapsed = this.#options.monotonicClock() - started;
          if (
            this.#active !== attempt ||
            !Number.isFinite(elapsed) ||
            elapsed < 0 ||
            elapsed >= DEADLINE_MS ||
            !Number.isSafeInteger(now) ||
            now < wallStarted ||
            now >= request.expiresAtMs ||
            envelope.receipt.issuedAtMs < wallStarted ||
            envelope.receipt.issuedAtMs > now ||
            envelope.receipt.expiresAtMs !== request.expiresAtMs ||
            envelope.receipt.issuedAtMs >= envelope.receipt.expiresAtMs
          )
            return yield* new SyntheticMigrationVerificationFailure({ code: "expired" });
          return {
            scope: "synthetic-only" as const,
            authenticatedHostResponse: true as const,
            artifactMatch: "exact-synthetic-artifact" as const,
            artifactManifestSha256: source.identity,
            expiresAtMs: request.expiresAtMs,
            runtimeAttested: false as const,
            destinationVerified: false as const,
            blockers: [...MIGRATION_PREPARATION_BLOCKERS],
            inventoryComplete: false as const,
            operations: { export: false as const, restore: false as const, activate: false as const },
          };
        }).pipe(
          Effect.timeoutOrElse({
            duration: DEADLINE_MS,
            orElse: () => Effect.fail(new SyntheticMigrationVerificationFailure({ code: "expired" })),
          }),
          Effect.catchDefect(() => Effect.fail(new SyntheticMigrationVerificationFailure({ code: "unavailable" }))),
        ),
      (attempt) =>
        Effect.sync(() => {
          if (this.#active === attempt) this.#active = null;
        }),
    ),
  );
}
