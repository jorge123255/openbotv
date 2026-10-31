// Synthetic acceptance only. These RFC 8032 section 7.1 keys are PUBLIC, forgeable test vectors.
// No generated key pair, secret-store read, real endpoint, TLS observation or production admission.
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MIGRATION_PREPARATION_BLOCKERS } from "@openbot/contracts/ipc-migration-preparation";
import { remoteHostFingerprint } from "@openbot/team-client/host-key-handover";
import { Deferred, Effect, Fiber, Result } from "effect";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { readMigrationAssessmentInventory } from "../src/main/migration-assessment-inventory";
import { MigrationAssessmentService } from "../src/main/migration-assessment-service";
import { readMigrationAssessmentSource } from "../src/main/migration-assessment-source";
import { MigrationPreparationService } from "../src/main/migration-preparation";
import { readMigrationPreparationInventory } from "../src/main/migration-preparation-inventory";
import { MIGRATION_PREPARATION_JOURNAL } from "../src/main/migration-preparation-store";
import {
  type SyntheticMigrationVerificationContext as Context,
  type SyntheticMigrationBuildManifest as Manifest,
  type SyntheticMigrationVerificationReceipt as Receipt,
  type SyntheticMigrationVerificationRequest as Request,
  SyntheticMigrationDestinationVerifier,
  SyntheticMigrationVerificationFailure,
  syntheticMigrationBuildStatement,
  syntheticMigrationReceiptStatement,
} from "../src/main/synthetic-migration-destination-verifier";

type Options = ConstructorParameters<typeof SyntheticMigrationDestinationVerifier>[0];
type Observation = Awaited<ReturnType<Options["observe"]>>;
type Artifact = Context["sourceArtifact"];
type Code = SyntheticMigrationVerificationFailure["code"];
const output = resolve(import.meta.dirname, "../.openbot-build/synthetic-migration-destination-verification-e2e");
const groups: Array<{ name: string; passed: boolean }> = [];
const EXPECTED_GROUPS = 17;
let refusalCount = 0;
let successCount = 0;
let base = "";
let database: OpenBotDatabase | null = null;
let baselineContext: Context | null = null;
let protectedFiles: Array<{ path: string; digest: string }> = [];
const START = Date.parse("2026-01-01T12:00:00.000Z");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// Published RFC 8032 TEST 1 and TEST 2 seeds. Never use either vector as a real credential.
const publisherKey = createPrivateKey({
  key: Buffer.concat([
    PKCS8_PREFIX,
    Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const hostKey = createPrivateKey({
  key: Buffer.concat([
    PKCS8_PREFIX,
    Buffer.from("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const publisherPublicKey = createPublicKey(publisherKey).export({ type: "spki", format: "pem" }).toString();
const hostPublicKey = createPublicKey(hostKey).export({ type: "spki", format: "pem" }).toString();
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fileHash = async (path: string) => hash(await readFile(path));

function artifact(changes: Partial<Manifest> = {}, bytes = Buffer.from([1, 2, 3, 4])): Artifact {
  const manifest: Manifest = {
    format: "openbot-synthetic-artifact-v1",
    artifactKind: "synthetic-package",
    platform: "darwin",
    architecture: "arm64",
    runtime: "desktop",
    byteLength: bytes.length,
    sha256: hash(bytes),
    ...changes,
  };
  const manifestJson = JSON.stringify(manifest);
  return {
    manifestJson,
    signature: sign(null, Buffer.from(syntheticMigrationBuildStatement(manifestJson)), publisherKey).toString(
      "base64url",
    ),
    bytesBase64Url: bytes.toString("base64url"),
  };
}
function manifestText(value: Artifact, text: string): Artifact {
  return {
    ...value,
    manifestJson: text,
    signature: sign(null, Buffer.from(syntheticMigrationBuildStatement(text)), publisherKey).toString("base64url"),
  };
}
function receipt(request: Request, changes: Partial<Receipt> = {}): Receipt {
  return {
    format: "openbot-synthetic-destination-receipt-v1",
    request,
    issuedAtMs: request.issuedAtMs,
    expiresAtMs: request.expiresAtMs,
    artifact: artifact(),
    capabilities: ["metadata-only", "migration-destination-synthetic-v1"],
    ...changes,
  };
}
function body(
  value: Receipt,
  key = hostKey,
  signature = sign(null, Buffer.from(syntheticMigrationReceiptStatement(value)), key).toString("base64url"),
) {
  return Buffer.from(JSON.stringify({ receipt: value, signature }));
}
function response(request: Request, changes: Partial<Receipt> = {}, key = hostKey): Observation {
  return {
    origin: request.destinationOrigin,
    status: 200,
    tls: "fixture-trusted",
    redirected: false,
    body: body(receipt(request, changes), key),
  };
}
function context() {
  assert.ok(baselineContext);
  return {
    ...baselineContext,
    pairing: { ...baselineContext.pairing },
    sourceArtifact: { ...baselineContext.sourceArtifact },
  };
}
function verifier(value: Context, changes: Partial<Options> = {}) {
  return new SyntheticMigrationDestinationVerifier({
    scope: "synthetic-only",
    readContext: () => Effect.succeed(value),
    observe: async (request) => response(request),
    wallClock: () => START,
    monotonicClock: () => 1000,
    ...changes,
  });
}
async function refused<A>(operation: Effect.Effect<A, SyntheticMigrationVerificationFailure>, code: Code) {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure.toJSON(), { _tag: "SyntheticMigrationVerificationFailure", code });
  refusalCount++;
}
async function success(operation: ReturnType<SyntheticMigrationDestinationVerifier["verify"]>) {
  const result = await Effect.runPromise(operation);
  assert.equal(result.scope, "synthetic-only");
  assert.equal(result.authenticatedHostResponse, true);
  assert.equal(result.artifactMatch, "exact-synthetic-artifact");
  assert.equal(result.artifactManifestSha256, hash(artifact().manifestJson));
  assert.equal(result.destinationVerified, false);
  assert.equal(result.runtimeAttested, false);
  assert.equal(result.inventoryComplete, false);
  assert.deepEqual(result.operations, { export: false, restore: false, activate: false });
  assert.deepEqual(result.blockers, [...MIGRATION_PREPARATION_BLOCKERS]);
  successCount++;
  return result;
}
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    for (const file of protectedFiles) assert.equal(await fileHash(file.path), file.digest);
    assert.equal(database?.connection.prepare("SELECT count(*) AS n FROM projection_routine_runs").get()?.n, 0);
    groups.push({ name, passed: true });
  } catch {
    // Fixed group names only. Never print a key, receipt, challenge, context or exception cause.
    groups.push({ name, passed: false });
  }
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}
function base64Alias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = value.at(-1);
  assert.ok(last);
  const index = alphabet.indexOf(last);
  assert.ok(index >= 0);
  const alias = `${value.slice(0, -1)}${alphabet[index ^ 1]}`;
  assert.notEqual(alias, value);
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(value, "base64url"));
  return alias;
}

async function interruptedObservation(actualDeadline: boolean) {
  const value = context();
  const entered = Deferred.makeUnsafe<Request>();
  const aborted = Deferred.makeUnsafe<void>();
  const lateSettled = Deferred.makeUnsafe<void>();
  const late: { resolve: () => void } = {
    resolve: () => {
      throw new Error("Synthetic observer has not entered.");
    },
  };
  let observations = 0;
  let reads = 0;
  const service = verifier(value, {
    readContext: () => {
      reads++;
      return Effect.succeed(value);
    },
    observe: (request, signal) => {
      observations++;
      if (observations > 1) return Promise.resolve(response(request));
      signal.addEventListener("abort", () => Effect.runSync(Deferred.succeed(aborted, undefined)), { once: true });
      const held = new Promise<Observation>((resolveObservation) => {
        late.resolve = () => resolveObservation(response(request));
      });
      Effect.runSync(Deferred.succeed(entered, request));
      return held.then((result) => {
        Effect.runSync(Deferred.succeed(lateSettled, undefined));
        return result;
      });
    },
  });
  const started = performance.now();
  const fiber = Effect.runFork(service.verify());
  try {
    await Effect.runPromise(Deferred.await(entered));
    await refused(service.verify(), "busy");
    if (actualDeadline) {
      await refused(Fiber.join(fiber), "expired");
      assert.ok(performance.now() - started >= 9000);
    } else await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(Deferred.await(aborted));
    assert.equal(reads, 1);
    await success(service.verify());
    const readCount = reads;
    late.resolve();
    await Effect.runPromise(Deferred.await(lateSettled));
    await Effect.runPromise(Effect.yieldNow);
    assert.equal(reads, readCount);
    await success(service.verify());
  } finally {
    late.resolve();
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
}

try {
  assert.equal(process.argv.length, 2);
  await mkdir(output, { recursive: true, mode: 0o700 });
  base = await mkdtemp(join(output, "generated-"));
  const profile = join(base, "profile");
  database = new OpenBotDatabase(profile);
  await Effect.runPromise(database.initialize());
  const preparation = new MigrationPreparationService({
    userDataPath: profile,
    now: () => new Date(START).toISOString(),
    readInventory: () =>
      readMigrationPreparationInventory(() => {
        assert.ok(database);
        return database.connection;
      }),
  });
  const prepared = await Effect.runPromise(
    preparation.prepare({ destinationKind: "other-server", expectedRevision: 0 }),
  );
  assert.ok(prepared.plan);
  const assessment = new MigrationAssessmentService({
    userDataPath: profile,
    preparation,
    now: () => new Date(START).toISOString(),
    readSource: () =>
      readMigrationAssessmentSource({
        appVersion: () => "1.2.3",
        platform: () => "darwin",
        architecture: () => "arm64",
      }),
    readInventory: () =>
      readMigrationAssessmentInventory({
        connection: () => {
          assert.ok(database);
          return database.connection;
        },
        userDataRoot: profile,
        managedRoot: join(base, "managed"),
        sourcePlatform: "darwin",
      }),
  });
  const assessed = await Effect.runPromise(
    assessment.assess({
      planId: prepared.plan.id,
      expectedPreparationRevision: prepared.revision,
      expectedAssessmentRevision: 0,
      destination: {
        platform: "darwin",
        architecture: "arm64",
        appVersion: "1.2.3",
        schemaVersion: 47,
        executor: "process",
        dataRoot: "owned",
        persistence: "persistent",
      },
    }),
  );
  assert.ok(assessed.assessment);
  const report = assessed.assessment;
  assert.ok(report.source.architecture === "arm64");
  baselineContext = {
    sourceHostId: "synthetic-source",
    sourceOwnerApproved: true,
    sourceRuntimeInstanceId: randomUUID(),
    sourcePlatform: report.source.platform,
    sourceArchitecture: report.source.architecture,
    planId: prepared.plan.id,
    preparationRevision: prepared.revision,
    preparationStatus: prepared.plan.status,
    assessmentId: report.id,
    assessmentRevision: report.revision,
    assessmentPlanId: report.planId,
    assessmentPreparationRevision: report.preparationRevision,
    assessmentSha256: hash(JSON.stringify(report)),
    pairing: {
      provenance: "independent-confirmation",
      sourceHostId: "synthetic-source",
      destinationHostId: "synthetic-destination",
      publicKey: hostPublicKey,
      fingerprint: remoteHostFingerprint(hostPublicKey),
      origin: "https://synthetic-destination.invalid",
      installationId: randomUUID(),
      runtimeInstanceId: randomUUID(),
      destinationOwnerAdmin: true,
    },
    publisherApproved: true,
    publisherPublicKey,
    sourceArtifact: artifact(),
  };
  protectedFiles = await Promise.all(
    [
      database.path,
      `${database.path}-wal`,
      join(profile, MIGRATION_PREPARATION_JOURNAL),
      join(profile, "openbot-migration-assessments-v1", report.planId, "1.json"),
    ].map(async (path) => ({ path, digest: await fileHash(path) })),
  );

  await check("public RFC vectors remain distinct and real report bindings yield synthetic success only", async () => {
    assert.equal(
      createPublicKey(publisherKey).export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
    assert.equal(
      createPublicKey(hostKey).export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
      "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    );
    assert.notEqual(hostPublicKey, publisherPublicKey);
    assert.equal(context().assessmentSha256, hash(JSON.stringify(report)));
    assert.equal(context().assessmentId, report.id);
    await success(verifier(context()).verify());
  });
  await check("verified signed bytes differ or cross platform architecture runtime and artifact kind", async () => {
    const mismatches: Array<Partial<Manifest>> = [
      { platform: "linux" },
      { architecture: "x64" },
      { runtime: "container" },
      { artifactKind: "synthetic-image" },
    ];
    for (const change of mismatches)
      await refused(
        verifier(context(), { observe: async (request) => response(request, { artifact: artifact(change) }) }).verify(),
        "platform-incompatible",
      );
    await refused(
      verifier(context(), {
        observe: async (request) => response(request, { artifact: artifact({}, Buffer.from([4, 3, 2, 1])) }),
      }).verify(),
      "build-mismatch",
    );
    const changed = context();
    changed.sourcePlatform = "linux";
    await refused(verifier(changed).verify(), "platform-incompatible");
  });
  await check("signed malformed manifests and publisher or byte substitutions never verify", async () => {
    const original = artifact();
    const malformed = [
      manifestText(original, `${original.manifestJson} `),
      manifestText(original, `${original.manifestJson.slice(0, -1)},"format":"openbot-synthetic-artifact-v1"}`),
      manifestText(original, `${original.manifestJson.slice(0, -1)},"unknown":true}`),
      {
        ...original,
        signature: sign(null, Buffer.from(syntheticMigrationBuildStatement(original.manifestJson)), hostKey).toString(
          "base64url",
        ),
      },
      { ...original, signature: base64Alias(original.signature) },
      { ...original, bytesBase64Url: Buffer.from([9, 9, 9, 9]).toString("base64url") },
      { ...original, bytesBase64Url: base64Alias(original.bytesBase64Url) },
    ];
    for (const bad of malformed)
      await refused(verifier({ ...context(), sourceArtifact: bad }).verify(), "build-unverified");
    await refused(
      verifier({
        ...context(),
        sourceArtifact: { ...original, bytesBase64Url: Buffer.alloc(4097).toString("base64url") },
      }).verify(),
      "invalid-context",
    );
  });
  await check("host signature wrong key tamper and noncanonical base64 are fixed refusals", async () => {
    await refused(
      verifier(context(), { observe: async (request) => response(request, {}, publisherKey) }).verify(),
      "signature-invalid",
    );
    await refused(
      verifier(context(), {
        observe: async (request) => {
          const signed = receipt(request);
          const signature = sign(null, Buffer.from(syntheticMigrationReceiptStatement(signed)), hostKey).toString(
            "base64url",
          );
          return {
            ...response(request),
            body: body({ ...signed, capabilities: ["migration-destination-synthetic-v1"] }, hostKey, signature),
          };
        },
      }).verify(),
      "signature-invalid",
    );
    await refused(
      verifier(context(), {
        observe: async (request) => {
          const signed = receipt(request);
          const signature = sign(null, Buffer.from(syntheticMigrationReceiptStatement(signed)), hostKey).toString(
            "base64url",
          );
          return { ...response(request), body: body(signed, hostKey, base64Alias(signature)) };
        },
      }).verify(),
      "signature-invalid",
    );
  });
  await check("strict response decoding refuses duplicates unknown fields BOM UTF8 size and whitespace", async () => {
    const mutations: Array<(value: Buffer, original: Receipt) => Uint8Array> = [
      (value) => Buffer.from(`${value.toString().slice(0, -1)},"unknown":true}`),
      (value, original) => Buffer.from(`${value.toString().slice(0, -1)},"receipt":${JSON.stringify(original)}}`),
      (value) => Buffer.from(`${value.toString()} `),
      (value) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), value]),
      () => Buffer.from([0xc3, 0x28]),
      () => Buffer.alloc(32769),
    ];
    for (const mutate of mutations)
      await refused(
        verifier(context(), {
          observe: async (request) => {
            const original = receipt(request);
            return { ...response(request), body: mutate(body(original), original) };
          },
        }).verify(),
        "invalid-response",
      );
  });
  await check(
    "all request nonce identity origin installation runtime report and build bindings are exact",
    async () => {
      const changes: Array<Partial<Request>> = [
        { requestId: randomUUID() },
        { challenge: "A".repeat(43) },
        { contextSha256: "0".repeat(64) },
        { sourceHostId: "different-source" },
        { destinationHostId: "different-host" },
        { destinationFingerprint: remoteHostFingerprint(publisherPublicKey) },
        { destinationOrigin: "https://other.invalid" },
        { installationId: randomUUID() },
        { runtimeInstanceId: randomUUID() },
        { publisherFingerprint: remoteHostFingerprint(hostPublicKey) },
        { sourceManifestSha256: "0".repeat(64) },
        { planId: randomUUID() },
        { preparationRevision: 2 },
        { assessmentId: randomUUID() },
        { assessmentRevision: 2 },
        { assessmentSha256: "0".repeat(64) },
        { issuedAtMs: START + 1 },
        { expiresAtMs: START + 60001 },
      ];
      for (const change of changes)
        await refused(
          verifier(context(), {
            observe: async (request) => response(request, { request: { ...request, ...change } }),
          }).verify(),
          "invalid-response",
        );
    },
  );
  await check("untrusted TLS origins redirects and HTTP failures refuse before reading the body", async () => {
    const changes: Array<Partial<Observation>> = [
      ...(["untrusted", "hostname-mismatch", "expired", "unknown"] as const).map((tls) => ({ tls })),
      ...[301, 302, 307, 308, 401, 500].map((status) => ({ status })),
      { redirected: true },
      { origin: "https://other.invalid" },
    ];
    for (const change of changes) {
      let reads = 0;
      await refused(
        verifier(context(), {
          observe: async (request) => ({
            ...response(request),
            ...change,
            get body(): Uint8Array {
              reads++;
              throw new Error("Synthetic body must remain unread.");
            },
          }),
        }).verify(),
        "transport-rejected",
      );
      assert.equal(reads, 0);
    }
  });
  await check("capability admission never promotes unsupported missing duplicate or unordered claims", async () => {
    const capabilities: Array<Receipt["capabilities"]> = [
      ["metadata-only"],
      ["migration-destination-synthetic-v1", "migration-destination-synthetic-v1"],
      ["migration-destination-synthetic-v1", "metadata-only"],
    ];
    for (const value of capabilities)
      await refused(
        verifier(context(), { observe: async (request) => response(request, { capabilities: value }) }).verify(),
        "capability-unavailable",
      );
  });
  await check("unapproved directory pins roles publishers and invalid plan links never reach observation", async () => {
    const contexts: Array<{ value: Context; code: Code }> = [
      { value: { ...context(), sourceOwnerApproved: false }, code: "unapproved" },
      { value: { ...context(), publisherApproved: false }, code: "unapproved" },
      { value: { ...context(), pairing: { ...context().pairing, destinationOwnerAdmin: false } }, code: "unapproved" },
      { value: { ...context(), pairing: { ...context().pairing, provenance: "directory-only" } }, code: "unapproved" },
      {
        value: {
          ...context(),
          pairing: { ...context().pairing, fingerprint: remoteHostFingerprint(publisherPublicKey) },
        },
        code: "unapproved",
      },
      {
        value: { ...context(), pairing: { ...context().pairing, origin: "http://synthetic-destination.invalid" } },
        code: "unapproved",
      },
      {
        value: { ...context(), pairing: { ...context().pairing, publicKey: hostPublicKey.trim() } },
        code: "unapproved",
      },
      { value: { ...context(), preparationStatus: "cancelled" }, code: "invalid-context" },
      { value: { ...context(), assessmentPlanId: randomUUID() }, code: "invalid-context" },
      { value: { ...context(), assessmentPreparationRevision: 2 }, code: "invalid-context" },
    ];
    for (const item of contexts) {
      let observed = 0;
      await refused(
        verifier(item.value, {
          observe: async (request) => {
            observed++;
            return response(request);
          },
        }).verify(),
        item.code,
      );
      assert.equal(observed, 0);
    }
  });
  await check(
    "context changes after endpoint await refuse while request and original snapshot stay fixed",
    async () => {
      const mutations: Array<{ mutate: (value: ReturnType<typeof context>) => void; code: Code }> = [
        {
          mutate: (value) => {
            value.assessmentRevision++;
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.assessmentSha256 = "0".repeat(64);
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.sourceRuntimeInstanceId = randomUUID();
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.pairing.runtimeInstanceId = randomUUID();
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.pairing.installationId = randomUUID();
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.pairing.origin = "https://changed.invalid";
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.pairing.publicKey = publisherPublicKey;
            value.pairing.fingerprint = remoteHostFingerprint(publisherPublicKey);
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.publisherPublicKey = hostPublicKey;
          },
          code: "context-changed",
        },
        {
          mutate: (value) => {
            value.sourceOwnerApproved = false;
          },
          code: "unapproved",
        },
        {
          mutate: (value) => {
            value.pairing.destinationOwnerAdmin = false;
          },
          code: "unapproved",
        },
        {
          mutate: (value) => {
            value.publisherApproved = false;
          },
          code: "unapproved",
        },
        {
          mutate: (value) => {
            value.pairing.provenance = "directory-only";
          },
          code: "unapproved",
        },
      ];
      for (const item of mutations) {
        const value = context();
        const before = JSON.stringify(value);
        await refused(
          verifier(value, {
            observe: async (request) => {
              assert.ok(Object.isFrozen(request));
              assert.equal(request.contextSha256, hash(before));
              assert.equal(Reflect.set(request, "planId", randomUUID()), false);
              const observed = response(request);
              await Effect.runPromise(Effect.yieldNow);
              item.mutate(value);
              return observed;
            },
          }).verify(),
          item.code,
        );
      }
    },
  );
  await check("context-read waits retain busy state and release it after cancellation is observed", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const value = context();
    let reads = 0;
    let observed = 0;
    const service = verifier(value, {
      readContext: () =>
        Effect.gen(function* () {
          reads++;
          if (reads === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return value;
        }),
      observe: async (request) => {
        observed++;
        return response(request);
      },
    });
    const fiber = Effect.runFork(service.verify());
    try {
      await Effect.runPromise(Deferred.await(entered));
      await refused(service.verify(), "busy");
      value.preparationStatus = "cancelled";
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await refused(Fiber.join(fiber), "invalid-context");
      assert.equal(observed, 0);
      value.preparationStatus = "prepared";
      await success(service.verify());
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    const readEntered = Deferred.makeUnsafe<void>();
    const readRelease = Deferred.makeUnsafe<void>();
    let contextReads = 0;
    let endpointCalls = 0;
    const heldContext = verifier(context(), {
      readContext: () =>
        Effect.gen(function* () {
          contextReads++;
          if (contextReads === 1) {
            yield* Deferred.succeed(readEntered, undefined);
            yield* Deferred.await(readRelease);
          }
          return context();
        }),
      observe: async (request) => {
        endpointCalls++;
        return response(request);
      },
    });
    const heldFiber = Effect.runFork(heldContext.verify());
    try {
      await Effect.runPromise(Deferred.await(readEntered));
      await Effect.runPromise(Fiber.interrupt(heldFiber));
      assert.equal(endpointCalls, 0);
      await success(heldContext.verify());
      assert.equal(endpointCalls, 1);
    } finally {
      await Effect.runPromise(Deferred.succeed(readRelease, undefined));
      await Effect.runPromise(Fiber.interrupt(heldFiber));
    }
  });
  await check("actual preparation cancellation invalidates a freshly read real assessment context", async () => {
    const secondaryProfile = join(base, "secondary-profile");
    const secondary = new OpenBotDatabase(secondaryProfile);
    try {
      await Effect.runPromise(secondary.initialize());
      const realPreparation = new MigrationPreparationService({
        userDataPath: secondaryProfile,
        now: () => new Date(START).toISOString(),
        readInventory: () => readMigrationPreparationInventory(() => secondary.connection),
      });
      const first = await Effect.runPromise(
        realPreparation.prepare({ destinationKind: "other-server", expectedRevision: 0 }),
      );
      assert.ok(first.plan);
      const plan = first.plan;
      const realAssessment = new MigrationAssessmentService({
        userDataPath: secondaryProfile,
        preparation: realPreparation,
        now: () => new Date(START).toISOString(),
        readSource: () =>
          readMigrationAssessmentSource({
            appVersion: () => "1.2.3",
            platform: () => "darwin",
            architecture: () => "arm64",
          }),
        readInventory: () =>
          readMigrationAssessmentInventory({
            connection: () => secondary.connection,
            userDataRoot: secondaryProfile,
            managedRoot: join(secondaryProfile, "managed"),
            sourcePlatform: "darwin",
          }),
      });
      await Effect.runPromise(
        realAssessment.assess({
          planId: plan.id,
          expectedPreparationRevision: first.revision,
          expectedAssessmentRevision: 0,
          destination: {
            platform: "darwin",
            architecture: "arm64",
            appVersion: "1.2.3",
            schemaVersion: 47,
            executor: "process",
            dataRoot: "owned",
            persistence: "persistent",
          },
        }),
      );
      const cancelledPath = join(secondaryProfile, MIGRATION_PREPARATION_JOURNAL);
      const sourcePaths = [
        secondary.path,
        `${secondary.path}-wal`,
        join(secondaryProfile, "openbot-migration-assessments-v1", first.plan.id, "1.json"),
      ];
      const before = await Promise.all(sourcePaths.map(fileHash));
      let contextReads = 0;
      let cancelledDigest = "";
      const service = verifier(context(), {
        readContext: () =>
          Effect.gen(function* () {
            contextReads++;
            const currentPreparation = yield* realPreparation.getState();
            const currentAssessment = yield* realAssessment.getState();
            assert.ok(currentPreparation.plan && currentAssessment.assessment);
            const currentReport = currentAssessment.assessment;
            return {
              ...context(),
              planId: currentPreparation.plan.id,
              preparationStatus: currentPreparation.plan.status,
              preparationRevision: currentPreparation.revision,
              assessmentId: currentReport.id,
              assessmentRevision: currentReport.revision,
              assessmentPlanId: currentReport.planId,
              assessmentPreparationRevision: currentReport.preparationRevision,
              assessmentSha256: hash(JSON.stringify(currentReport)),
            };
          }).pipe(Effect.mapError(() => new SyntheticMigrationVerificationFailure({ code: "invalid-context" }))),
        observe: async (request) => {
          await Effect.runPromise(realPreparation.cancel({ planId: plan.id, expectedRevision: first.revision }));
          cancelledDigest = await fileHash(cancelledPath);
          return response(request);
        },
      });
      await refused(service.verify(), "invalid-context");
      assert.equal(contextReads, 2);
      assert.ok(cancelledDigest);
      assert.equal(await fileHash(cancelledPath), cancelledDigest);
      assert.deepEqual(await Promise.all(sourcePaths.map(fileHash)), before);
      assert.equal((await Effect.runPromise(realAssessment.getState())).applicability, "stale");
      assert.equal(secondary.connection.prepare("SELECT count(*) AS n FROM projection_routine_runs").get()?.n, 0);
    } finally {
      secondary.close();
    }
  });
  await check("receipt expiry wall rollback monotonic rollback and late completion refuse", async () => {
    for (const change of [{ issuedAtMs: START - 1 }, { issuedAtMs: START + 1 }, { expiresAtMs: START + 59999 }])
      await refused(verifier(context(), { observe: async (request) => response(request, change) }).verify(), "expired");
    for (const after of [
      { wall: START - 1, mono: 1000 },
      { wall: START + 60000, mono: 1000 },
      { wall: START, mono: 999 },
      { wall: START, mono: 11000 },
      { wall: START, mono: Number.NaN },
    ]) {
      const clock = { wall: START, mono: 1000 };
      await refused(
        verifier(context(), {
          wallClock: () => clock.wall,
          monotonicClock: () => clock.mono,
          observe: async (request) => {
            clock.wall = after.wall;
            clock.mono = after.mono;
            return response(request);
          },
        }).verify(),
        "expired",
      );
    }
    await refused(verifier(context(), { monotonicClock: () => Number.NaN }).verify(), "expired");
    await refused(verifier(context(), { wallClock: () => -1 }).verify(), "expired");
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let monotonic = 1000;
    let calls = 0;
    const held = verifier(context(), {
      monotonicClock: () => monotonic,
      readContext: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return context();
        }),
      observe: async (request) => {
        calls++;
        return response(request);
      },
    });
    const fiber = Effect.runFork(held.verify());
    try {
      await Effect.runPromise(Deferred.await(entered));
      monotonic = 11000;
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await refused(Fiber.join(fiber), "expired");
      assert.equal(calls, 0);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
  await check("a receipt from a previous attempt cannot satisfy a new request or a new verifier", async () => {
    const requests: Request[] = [];
    let previous: Observation | null = null;
    const service = verifier(context(), {
      observe: async (request) => {
        requests.push(request);
        if (requests.length === 2) {
          assert.ok(previous);
          return previous;
        }
        const observed = response(request);
        previous = observed;
        return observed;
      },
    });
    await success(service.verify());
    await refused(service.verify(), "invalid-response");
    await success(service.verify());
    assert.equal(new Set(requests.map((request) => request.requestId)).size, 3);
    assert.equal(new Set(requests.map((request) => request.challenge)).size, 3);
    assert.ok(previous);
    const replay = previous;
    await refused(verifier(context(), { observe: async () => replay }).verify(), "invalid-response");
  });
  await check("external interruption aborts observation releases busy state and ignores late fulfillment", async () => {
    await interruptedObservation(false);
  });
  await check("actual ten second deadline aborts a signal-ignoring observer and ignores its late result", async () => {
    await interruptedObservation(true);
  });
  await check("thirty two fresh attempts exhaust the memory-only verifier without a persistent grant", async () => {
    const requests = new Set<string>();
    const service = verifier(context(), {
      observe: async (request) => {
        requests.add(request.requestId);
        return response(request);
      },
    });
    for (let attempt = 0; attempt < 32; attempt++) await success(service.verify());
    await refused(service.verify(), "attempt-limit");
    assert.equal(requests.size, 32);
  });
} catch {
  groups.push({ name: "generated-fixture-or-harness-setup", passed: false });
} finally {
  try {
    database?.close();
  } catch {
    groups.push({ name: "owned-fixture-close", passed: false });
  }
  database = null;
  try {
    if (base) await rm(base, { recursive: true, force: true });
  } catch {
    groups.push({ name: "owned-fixture-cleanup", passed: false });
    process.stdout.write("FAIL owned-fixture-cleanup\n");
  }
  const passed = groups.length === EXPECTED_GROUPS && groups.every((group) => group.passed);
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(
      join(output, "report.json"),
      `${JSON.stringify(
        {
          passed,
          expectedGroups: EXPECTED_GROUPS,
          syntheticOnly: true,
          publicForgeableTestVectorsOnly: true,
          realGeneratedProfileServices: true,
          successCount,
          refusalCount,
          groups,
          realDataAccessed: false,
          credentialsAccessed: false,
          newKeyPairsGenerated: false,
          privateKeysPersisted: false,
          actualNetworkUsed: false,
          actualTLSVerified: false,
          appStarted: false,
          runtimeAttested: false,
          destinationVerified: false,
          exportAvailable: false,
          restoreAvailable: false,
          activationAvailable: false,
          persistentGrantCreated: false,
          limits: [
            "Public test vectors do not establish trust",
            "Endpoint and owner assertions are injected",
            "No source request authentication proof",
            "No production wiring or durable replay proof",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    process.stdout.write("FAIL redacted-report-write\n");
    process.exitCode = 1;
  }
}
if (groups.length !== EXPECTED_GROUPS || groups.some((group) => !group.passed)) process.exitCode = 1;
