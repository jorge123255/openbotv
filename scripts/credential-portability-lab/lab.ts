// Development-only memory stores. No filesystem, OS credentials, provider, network or app imports.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Deferred, Effect } from "effect";
import { newFixtureKey, openFixtureBytes, sealFixtureBytes } from "./envelope";
import { CredentialLabFailure, contextOf, decodeFixturePayload, type FixturePayload } from "./model";

export type PayloadFault =
  | "none"
  | "source-unavailable"
  | "wrong-key"
  | "wrong-source"
  | "wrong-destination"
  | "wrong-snapshot"
  | "wrong-transfer"
  | "wrong-baseline"
  | "missing-credential"
  | "extra-credential"
  | "duplicate-credential"
  | "swapped-account"
  | "wrong-scope"
  | "changed-portable-value"
  | "unknown-adapter-version"
  | "duplicate-account"
  | "duplicate-agent"
  | "extra-account"
  | "dangling-agent"
  | "untransferable-secret"
  | "unknown-kind"
  | "unknown-version"
  | "unknown-field"
  | "duplicate-json"
  | "invalid-utf8"
  | "utf8-bom"
  | "oversized";
export type StageFault = "none" | "destination-unavailable" | "after-rewrap" | "verification-failure" | "before-commit";
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (ciphertext: string) => createHash("sha256").update(ciphertext).digest("hex");
const id = () => `fixture-${randomUUID()}`;
interface FixtureKeys {
  source: CryptoKey;
  transfer: CryptoKey;
  destination: CryptoKey;
}
const checked = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof CredentialLabFailure ? error : new CredentialLabFailure({ code: "PAYLOAD_REJECTED" }),
  });

function useFixtureBytes<A, E, E2>(
  acquire: Effect.Effect<Uint8Array, E>,
  use: (bytes: Uint8Array) => Effect.Effect<A, E2>,
) {
  return Effect.acquireUseRelease(acquire, use, (bytes) =>
    Effect.sync(() => {
      bytes.fill(0);
    }),
  );
}

function alteredBytes(payload: FixturePayload, fault: PayloadFault): Uint8Array {
  const first = payload.credentials[0];
  if (!first) throw new CredentialLabFailure({ code: "PAYLOAD_REJECTED" });
  let text = JSON.stringify(payload);
  switch (fault) {
    case "wrong-source":
      text = JSON.stringify({ ...payload, binding: { ...payload.binding, sourceId: id() } });
      break;
    case "wrong-destination":
      text = JSON.stringify({ ...payload, binding: { ...payload.binding, destinationId: id() } });
      break;
    case "wrong-snapshot":
      text = JSON.stringify({ ...payload, binding: { ...payload.binding, snapshotSha256: "0".repeat(64) } });
      break;
    case "wrong-transfer":
      text = JSON.stringify({ ...payload, binding: { ...payload.binding, transferId: id() } });
      break;
    case "wrong-baseline":
      text = JSON.stringify({ ...payload, binding: { ...payload.binding, baselineSha256: "0".repeat(64) } });
      break;
    case "missing-credential":
      text = JSON.stringify({ ...payload, credentials: payload.credentials.slice(1) });
      break;
    case "extra-credential":
      text = JSON.stringify({ ...payload, credentials: [...payload.credentials, { ...first, credentialId: id() }] });
      break;
    case "duplicate-credential":
      text = JSON.stringify({ ...payload, credentials: [...payload.credentials, first] });
      break;
    case "swapped-account":
      text = JSON.stringify({
        ...payload,
        credentials: [
          { ...first, accountId: "fixture-account-b", agentIds: ["fixture-agent-b"] },
          ...payload.credentials.slice(1),
        ],
      });
      break;
    case "wrong-scope":
      text = JSON.stringify({
        ...payload,
        credentials: [{ ...first, scope: "fixture://provider/unexpected" }, ...payload.credentials.slice(1)],
      });
      break;
    case "changed-portable-value":
      text = JSON.stringify({
        ...payload,
        credentials: [
          { ...first, secret: `synthetic-secret-${randomBytes(32).toString("hex")}` },
          ...payload.credentials.slice(1),
        ],
      });
      break;
    case "unknown-adapter-version":
      text = JSON.stringify({
        ...payload,
        credentials: [{ ...first, adapterVersion: 2 }, ...payload.credentials.slice(1)],
      });
      break;
    case "duplicate-account":
      text = JSON.stringify({ ...payload, accounts: [...payload.accounts, payload.accounts[0]] });
      break;
    case "duplicate-agent":
      text = JSON.stringify({ ...payload, agents: [...payload.agents, payload.agents[0]] });
      break;
    case "extra-account":
      text = JSON.stringify({ ...payload, accounts: [...payload.accounts, { id: id() }] });
      break;
    case "dangling-agent":
      text = JSON.stringify({
        ...payload,
        credentials: [{ ...first, agentIds: ["fixture-missing-agent"] }, ...payload.credentials.slice(1)],
      });
      break;
    case "untransferable-secret":
      text = JSON.stringify({
        ...payload,
        credentials: payload.credentials.map((record) =>
          record.status === "unavailable" ? { ...record, secret: "synthetic-secret-forbidden" } : record,
        ),
      });
      break;
    case "unknown-kind":
      text = JSON.stringify({
        ...payload,
        credentials: [{ ...first, kind: "unknown" }, ...payload.credentials.slice(1)],
      });
      break;
    case "unknown-version":
      text = JSON.stringify({ ...payload, version: 99 });
      break;
    case "unknown-field":
      text = JSON.stringify({ ...payload, extra: true });
      break;
    case "duplicate-json":
      text = text.replace('"version":1', '"version":1,"version":1');
      break;
    case "invalid-utf8":
      return new Uint8Array([255, 254]);
    case "utf8-bom":
      return new Uint8Array([239, 187, 191, ...encode(text)]);
    case "oversized":
      return new Uint8Array(16 * 1024 + 1);
  }
  return encode(text);
}

/** Owns only generated encrypted memory stores and a single-process candidate/replay model. */
export class SyntheticCredentialLab {
  readonly #payload: FixturePayload;
  readonly #expected: ReturnType<typeof contextOf>;
  readonly #sourceDigest: string;
  readonly #baselineDigest: string;
  #keys: FixtureKeys | null;
  #source: string;
  #baseline: string;
  #snapshot: string;
  #revision = 0;
  #candidate: string | null = null;
  readonly #consumed = new Set<string>();
  #commitGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null = null;

  private constructor(payload: FixturePayload, keys: FixtureKeys, source: string, baseline: string, snapshot: string) {
    this.#payload = payload;
    this.#expected = contextOf(payload);
    this.#keys = keys;
    this.#source = source;
    this.#baseline = baseline;
    this.#snapshot = snapshot;
    this.#sourceDigest = digest(source);
    this.#baselineDigest = digest(baseline);
  }

  static readonly create = Effect.fn("SyntheticCredentialLab.create")(function* () {
    const keys = {
      source: yield* newFixtureKey(),
      transfer: yield* newFixtureKey(),
      destination: yield* newFixtureKey(),
    };
    const baseline = yield* sealFixtureBytes(
      encode(`synthetic-destination-baseline-${randomUUID()}`),
      keys.destination,
      "destination",
    );
    const sourceId = id();
    const snapshot = JSON.stringify({ fixture: true, sourceId, dataset: id() });
    const common = {
      accountId: "fixture-account-a",
      agentIds: ["fixture-agent-a"],
      scope: "fixture://provider/a",
      adapterVersion: 1,
    } satisfies Pick<FixturePayload["credentials"][number], "accountId" | "agentIds" | "scope" | "adapterVersion">;
    const payload: FixturePayload = {
      format: "openbot-synthetic-credential-envelope",
      version: 1,
      binding: {
        transferId: id(),
        sourceId,
        destinationId: id(),
        snapshotSha256: digest(snapshot),
        baselineSha256: digest(baseline),
      },
      accounts: [{ id: "fixture-account-a" }, { id: "fixture-account-b" }],
      agents: [
        { id: "fixture-agent-a", accountId: "fixture-account-a" },
        { id: "fixture-agent-b", accountId: "fixture-account-b" },
      ],
      credentials: [
        {
          ...common,
          credentialId: "fixture-api-key",
          kind: "api-key",
          status: "synthetic-portable",
          secret: `synthetic-secret-${randomBytes(32).toString("hex")}`,
        },
        {
          ...common,
          accountId: "fixture-account-b",
          agentIds: ["fixture-agent-b"],
          scope: "fixture://provider/b",
          credentialId: "fixture-refresh-token",
          kind: "refresh-token",
          status: "synthetic-portable",
          secret: `synthetic-secret-${randomBytes(32).toString("hex")}`,
        },
        {
          ...common,
          credentialId: "fixture-device-oauth",
          kind: "device-oauth",
          status: "reauthentication-required",
          reason: "os-or-device-bound",
        },
        {
          ...common,
          credentialId: "fixture-browser-login",
          kind: "browser-login",
          status: "reauthentication-required",
          reason: "os-or-device-bound",
        },
        {
          ...common,
          credentialId: "fixture-hardware-key",
          kind: "hardware-key",
          status: "unavailable",
          reason: "nonexportable",
        },
      ],
    };
    return yield* useFixtureBytes(
      Effect.sync(() => encode(JSON.stringify(payload))),
      (bytes) =>
        Effect.gen(function* () {
          yield* checked(() => decodeFixturePayload(bytes, contextOf(payload)));
          const source = yield* sealFixtureBytes(bytes, keys.source, "source");
          return new SyntheticCredentialLab(payload, keys, source, baseline, snapshot);
        }),
    );
  });

  inspect() {
    return Object.freeze({
      revision: this.#revision,
      candidatePresent: this.#candidate !== null,
      consumed: this.#consumed.size,
      sourceCiphertextSha256: digest(this.#source),
      baselineCiphertextSha256: digest(this.#baseline),
      snapshotSha256: digest(this.#snapshot),
      candidateCiphertextSha256: this.#candidate ? digest(this.#candidate) : null,
      keysAvailable: this.#keys !== null,
      keysNonextractable: this.#keys ? Object.values(this.#keys).every((key) => !key.extractable) : null,
      keysSeparate: this.#keys ? new Set(Object.values(this.#keys)).size === 3 : null,
      productionImportAvailable: false,
      durableReplayImplemented: false,
      sourceAuthenticationVerified: false,
      oneWriterFenceImplemented: false,
      fullMigrationComplete: false,
    });
  }

  #assertContext() {
    if (
      digest(this.#snapshot) !== this.#expected.binding.snapshotSha256 ||
      digest(this.#baseline) !== this.#baselineDigest ||
      digest(this.#source) !== this.#sourceDigest
    )
      throw new CredentialLabFailure({ code: "CONTEXT_MISMATCH" });
  }

  /** The private generated source is a lab oracle, not a production destination trust protocol. */
  #assertSourceValues(payload: FixturePayload): void {
    for (const record of payload.credentials) {
      if (record.status !== "synthetic-portable") continue;
      const source = this.#payload.credentials.find((item) => item.credentialId === record.credentialId);
      if (source?.status !== "synthetic-portable") throw new CredentialLabFailure({ code: "SOURCE_VALUE_MISMATCH" });
      const actual = encode(record.secret);
      const expected = encode(source.secret);
      try {
        if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected))
          throw new CredentialLabFailure({ code: "SOURCE_VALUE_MISMATCH" });
      } finally {
        actual.fill(0);
        expected.fill(0);
      }
    }
  }

  readonly exportFixture = Effect.fn("SyntheticCredentialLab.export")(function* (
    this: SyntheticCredentialLab,
    approval: "source-export-approved" | "missing" = "missing",
    fault: PayloadFault = "none",
  ) {
    if (approval !== "source-export-approved") return yield* new CredentialLabFailure({ code: "APPROVAL_REQUIRED" });
    if (fault === "source-unavailable") return yield* new CredentialLabFailure({ code: "ADAPTER_UNAVAILABLE" });
    const keys = this.#keys;
    if (!keys) return yield* new CredentialLabFailure({ code: "KEY_UNAVAILABLE" });
    yield* checked(() => this.#assertContext());
    const lab = this;
    return yield* useFixtureBytes(openFixtureBytes(this.#source, keys.source, "source"), (source) =>
      Effect.gen(function* () {
        const payload = yield* checked(() => decodeFixturePayload(source, lab.#expected));
        return yield* useFixtureBytes(
          checked(() => alteredBytes(payload, fault)),
          (bytes) =>
            Effect.gen(function* () {
              const key = fault === "wrong-key" ? yield* newFixtureKey() : keys.transfer;
              const token = yield* sealFixtureBytes(bytes, key, "transfer");
              if (lab.#keys !== keys) return yield* new CredentialLabFailure({ code: "KEY_UNAVAILABLE" });
              return token;
            }),
        );
      }),
    );
  });

  readonly stageFixture = Effect.fn("SyntheticCredentialLab.stage")(function* (
    this: SyntheticCredentialLab,
    token: string,
    expectedRevision: number,
    approval: "destination-stage-approved" | "missing" = "missing",
    fault: StageFault = "none",
  ) {
    if (approval !== "destination-stage-approved")
      return yield* new CredentialLabFailure({ code: "APPROVAL_REQUIRED" });
    const keys = this.#keys;
    if (!keys) return yield* new CredentialLabFailure({ code: "KEY_UNAVAILABLE" });
    if (this.#revision !== expectedRevision) return yield* new CredentialLabFailure({ code: "REVISION_CONFLICT" });
    yield* checked(() => this.#assertContext());
    const lab = this;
    return yield* useFixtureBytes(openFixtureBytes(token, keys.transfer, "transfer"), (bytes) =>
      Effect.gen(function* () {
        const payload = yield* checked(() => decodeFixturePayload(bytes, lab.#expected));
        yield* checked(() => lab.#assertSourceValues(payload));
        if (lab.#consumed.has(payload.binding.transferId))
          return yield* new CredentialLabFailure({ code: "REPLAY_REFUSED" });
        if (fault === "destination-unavailable")
          return yield* new CredentialLabFailure({ code: "ADAPTER_UNAVAILABLE" });
        const candidate = yield* sealFixtureBytes(bytes, keys.destination, "destination");
        if (fault === "after-rewrap") return yield* new CredentialLabFailure({ code: "INJECTED_FAILURE" });
        yield* useFixtureBytes(openFixtureBytes(candidate, keys.destination, "destination"), (verified) =>
          Effect.gen(function* () {
            if (fault === "verification-failure" || Buffer.compare(verified, bytes) !== 0)
              return yield* new CredentialLabFailure({ code: "CANDIDATE_VERIFICATION_FAILED" });
            yield* checked(() => decodeFixturePayload(verified, lab.#expected));
          }),
        );
        if (fault === "before-commit") return yield* new CredentialLabFailure({ code: "INJECTED_FAILURE" });
        const gate = lab.#commitGate;
        lab.#commitGate = null;
        if (gate) {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        yield* checked(() => lab.#assertContext());
        if (lab.#keys !== keys) return yield* new CredentialLabFailure({ code: "KEY_UNAVAILABLE" });
        if (lab.#revision !== expectedRevision) return yield* new CredentialLabFailure({ code: "REVISION_CONFLICT" });
        // No await or external effect splits the single-process model commit below.
        lab.#candidate = candidate;
        lab.#consumed.add(payload.binding.transferId);
        lab.#revision++;
        return Object.freeze({
          portableBytesPreserved: 2,
          syntheticDestinationWrappingVerified: 2,
          reauthenticationRequired: 2,
          unavailable: 1,
          associationsPreserved: true,
          remoteUsability: "not-tested",
          state: "verified-synthetic-candidate",
          productionImportAvailable: false,
        });
      }),
    );
  });

  readonly rollbackFixture = Effect.fn("SyntheticCredentialLab.rollback")(function* (
    this: SyntheticCredentialLab,
    expectedRevision: number,
    approval: "candidate-discard-approved" | "missing" = "missing",
  ) {
    if (approval !== "candidate-discard-approved")
      return yield* new CredentialLabFailure({ code: "APPROVAL_REQUIRED" });
    if (this.#revision !== expectedRevision) return yield* new CredentialLabFailure({ code: "REVISION_CONFLICT" });
    this.#candidate = null;
    this.#revision++;
    // Consumed IDs stay spent through rollback within this model's lifetime.
  });

  readonly activate = () => Effect.fail(new CredentialLabFailure({ code: "ACTIVATION_UNAVAILABLE" }));

  /** Test-owned state barrier, so cancellation and late changes are checked without a timed sleep. */
  readonly holdBeforeFixtureCommit = Effect.fn("SyntheticCredentialLab.holdBeforeCommit")(function* (
    this: SyntheticCredentialLab,
  ) {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    this.#commitGate = { entered, release };
    return Object.freeze({ entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) });
  });

  modelKeyLoss() {
    this.#keys = null;
  }
  modelSnapshotChange() {
    this.#snapshot += "synthetic-change";
  }
  modelBaselineChange() {
    this.#baseline += "synthetic-change";
  }

  assertSafeText(text: string): void {
    for (const record of this.#payload.credentials) {
      if (record.status === "synthetic-portable" && text.includes(record.secret))
        throw new CredentialLabFailure({ code: "DIAGNOSTIC_REFUSED" });
    }
  }

  diagnosticLeakProbe(): void {
    const first = this.#payload.credentials[0];
    if (first?.status !== "synthetic-portable") throw new CredentialLabFailure({ code: "PAYLOAD_REJECTED" });
    this.assertSafeText(first.secret);
  }
}
