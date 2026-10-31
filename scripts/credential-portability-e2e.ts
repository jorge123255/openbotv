// Synthetic memory stores only. Accepts no paths, keys, tokens, credentials or CLI options.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { base64url, CompactEncrypt, compactDecrypt } from "jose";
import {
  type FixtureEnvelopeFailure,
  newFixtureKey,
  openFixtureBytes,
  sealFixtureBytes,
} from "./credential-portability-lab/envelope";
import { type PayloadFault, type StageFault, SyntheticCredentialLab } from "./credential-portability-lab/lab";
import { CredentialLabFailure } from "./credential-portability-lab/model";

const root = resolve(import.meta.dirname, "../.openbot-build/credential-portability-e2e");
const groups: Array<{ name: string; passed: boolean }> = [];
const labs: SyntheticCredentialLab[] = [];
let refusalCases = 0;
const create = async () => {
  const lab = await Effect.runPromise(SyntheticCredentialLab.create());
  labs.push(lab);
  return lab;
};
const exported = (lab: SyntheticCredentialLab, fault: PayloadFault = "none") =>
  Effect.runPromise(lab.exportFixture("source-export-approved", fault));
const stage = (lab: SyntheticCredentialLab, token: string, revision = 0, fault: StageFault = "none") =>
  lab.stageFixture(token, revision, "destination-stage-approved", fault);

async function refuse<A>(operation: Effect.Effect<A, CredentialLabFailure | FixtureEnvelopeFailure>, code: string) {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.code, code);
  const publicError = result.failure.toJSON();
  assert.ok(publicError !== null && typeof publicError === "object");
  assert.deepEqual(Object.keys(publicError).sort(), ["_tag", "code"]);
  refusalCases++;
}

async function unchangedRefusal<A>(
  lab: SyntheticCredentialLab,
  operation: Effect.Effect<A, CredentialLabFailure | FixtureEnvelopeFailure>,
  code: string,
) {
  const before = lab.inspect();
  await refuse(operation, code);
  assert.deepEqual(lab.inspect(), before);
}

function replace(token: string, index: number, value: string) {
  const parts = token.split(".");
  assert.equal(parts.length, 5);
  parts[index] = value;
  return parts.join(".");
}
function flip(token: string, index: number) {
  const part = token.split(".")[index];
  assert.ok(part);
  const bytes = base64url.decode(part);
  assert.ok(bytes.length);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return replace(token, index, base64url.encode(bytes));
}

async function check(name: string, operation: () => Promise<void>) {
  try {
    await operation();
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  // Machine-readable: only fixed test labels, never exception messages or credential values.
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}

try {
  assert.equal(process.argv.length, 2);
  await check("rewrap-preserves-values-associations-and-unresolved-status", async () => {
    const lab = await create();
    const before = lab.inspect();
    assert.equal(before.keysNonextractable, true);
    assert.equal(before.keysSeparate, true);
    const token = await exported(lab);
    lab.assertSafeText(token);
    const header = JSON.parse(new TextDecoder().decode(base64url.decode(token.split(".")[0] ?? "")));
    assert.deepEqual(Object.keys(header).sort(), ["alg", "cty", "enc", "typ"]);
    const receipt = await Effect.runPromise(stage(lab, token));
    assert.deepEqual(receipt, {
      portableBytesPreserved: 2,
      syntheticDestinationWrappingVerified: 2,
      reauthenticationRequired: 2,
      unavailable: 1,
      associationsPreserved: true,
      remoteUsability: "not-tested",
      state: "verified-synthetic-candidate",
      productionImportAvailable: false,
    });
    const after = lab.inspect();
    assert.equal(after.sourceCiphertextSha256, before.sourceCiphertextSha256);
    assert.equal(after.baselineCiphertextSha256, before.baselineCiphertextSha256);
    assert.equal(after.candidatePresent, true);
    assert.equal(after.revision, 1);
    assert.equal(after.consumed, 1);
    assert.equal(after.fullMigrationComplete, false);
  });
  await check("fresh-library-ivs-for-repeated-fixture-export", async () => {
    const lab = await create();
    const first = await exported(lab);
    const second = await exported(lab);
    assert.notEqual(first, second);
    assert.notEqual(first.split(".")[2], second.split(".")[2]);
  });
  await check("separate-synthetic-approval-and-adapter-gates", async () => {
    const lab = await create();
    await unchangedRefusal(lab, lab.exportFixture(), "APPROVAL_REQUIRED");
    await unchangedRefusal(
      lab,
      lab.exportFixture("source-export-approved", "source-unavailable"),
      "ADAPTER_UNAVAILABLE",
    );
    const token = await exported(lab);
    await unchangedRefusal(lab, lab.stageFixture(token, 0), "APPROVAL_REQUIRED");
    await unchangedRefusal(lab, stage(lab, token, 0, "destination-unavailable"), "ADAPTER_UNAVAILABLE");
  });
  await check("wrong-key-and-tampered-iv-ciphertext-tag-refuse", async () => {
    const lab = await create();
    await unchangedRefusal(lab, stage(lab, await exported(lab, "wrong-key")), "ENVELOPE_REJECTED");
    const token = await exported(lab);
    for (const index of [2, 3, 4]) await unchangedRefusal(lab, stage(lab, flip(token, index)), "ENVELOPE_REJECTED");
  });
  await check("fixed-header-rejects-algorithms-compression-discovery-and-duplicates", async () => {
    const lab = await create();
    const token = await exported(lab);
    const header = {
      alg: "dir",
      enc: "A256GCM",
      typ: "openbot-synthetic-credentials-transfer+jwe",
      cty: "application/octet-stream",
    };
    for (const invalid of [
      { ...header, alg: "none" },
      { ...header, enc: "A128CBC-HS256" },
      { ...header, zip: "DEF" },
      { ...header, kid: "fixture-key" },
      { ...header, jku: "https://invalid.example/key" },
      { ...header, jwk: {} },
      { ...header, crit: ["extra"], extra: true },
      { ...header, extra: true },
      { ...header, typ: "openbot-synthetic-credentials-source+jwe" },
    ])
      await unchangedRefusal(
        lab,
        stage(lab, replace(token, 0, base64url.encode(JSON.stringify(invalid)))),
        "ENVELOPE_REJECTED",
      );
    const duplicate = JSON.stringify(header).replace('"alg":"dir"', '"alg":"dir","alg":"dir"');
    await unchangedRefusal(lab, stage(lab, replace(token, 0, base64url.encode(duplicate))), "ENVELOPE_REJECTED");
  });
  await check("wire-size-framing-and-canonical-encoding-refuse", async () => {
    const lab = await create();
    const token = await exported(lab);
    for (const invalid of [
      "plaintext",
      "",
      "A".repeat(32 * 1024 + 1),
      token.slice(0, -4),
      `${token}.extra`,
      replace(token, 1, "AA"),
      replace(token, 2, "A".repeat(17)),
      `${token}=`,
      `${token}é`,
    ])
      await unchangedRefusal(lab, stage(lab, invalid), "ENVELOPE_REJECTED");
    await unchangedRefusal(lab, lab.exportFixture("source-export-approved", "oversized"), "ENVELOPE_REJECTED");
    const tag = token.split(".")[4];
    assert.ok(tag);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = tag.at(-1);
    assert.ok(last);
    const alias = `${tag.slice(0, -1)}${alphabet[alphabet.indexOf(last) + 1]}`;
    assert.deepEqual(base64url.decode(alias), base64url.decode(tag));
    assert.notEqual(alias, tag);
    await unchangedRefusal(lab, stage(lab, replace(token, 4, alias)), "ENVELOPE_REJECTED");
  });
  await check("authenticated-header-policy-refuses-valid-wrong-purpose-and-extra-field", async () => {
    const key = await Effect.runPromise(newFixtureKey());
    const bytes = new TextEncoder().encode("synthetic nonsecret header-policy probe");
    const source = await Effect.runPromise(sealFixtureBytes(bytes, key, "source"));
    const opened = await Effect.runPromise(openFixtureBytes(source, key, "source"));
    assert.deepEqual(opened, bytes);
    opened.fill(0);
    await refuse(openFixtureBytes(source, key, "transfer"), "ENVELOPE_REJECTED");
    const withExtra = await new CompactEncrypt(bytes)
      .setProtectedHeader({
        alg: "dir",
        enc: "A256GCM",
        typ: "openbot-synthetic-credentials-transfer+jwe",
        cty: "application/octet-stream",
        extra: true,
      })
      .encrypt(key);
    const authenticated = await compactDecrypt(withExtra, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      maxDecompressedLength: 0,
    });
    assert.deepEqual(authenticated.plaintext, bytes);
    authenticated.plaintext.fill(0);
    bytes.fill(0);
    await refuse(openFixtureBytes(withExtra, key, "transfer"), "ENVELOPE_REJECTED");
  });
  await check("authenticated-wrong-context-and-identity-sets-refuse", async () => {
    const lab = await create();
    const faults: PayloadFault[] = [
      "wrong-source",
      "wrong-destination",
      "wrong-snapshot",
      "wrong-transfer",
      "wrong-baseline",
      "missing-credential",
      "extra-credential",
      "swapped-account",
      "wrong-scope",
      "extra-account",
    ];
    for (const fault of faults) await unchangedRefusal(lab, stage(lab, await exported(lab, fault)), "CONTEXT_MISMATCH");
  });
  await check("authenticated-invalid-payload-cannot-stage-partial-credentials", async () => {
    const lab = await create();
    const faults: PayloadFault[] = [
      "duplicate-credential",
      "duplicate-account",
      "duplicate-agent",
      "unknown-adapter-version",
      "dangling-agent",
      "untransferable-secret",
      "unknown-kind",
      "unknown-version",
      "unknown-field",
      "duplicate-json",
      "invalid-utf8",
      "utf8-bom",
    ];
    for (const fault of faults) await unchangedRefusal(lab, stage(lab, await exported(lab, fault)), "PAYLOAD_REJECTED");
    await unchangedRefusal(lab, stage(lab, await exported(lab, "changed-portable-value")), "SOURCE_VALUE_MISMATCH");
  });
  await check("failed-rewrap-verification-and-publication-preserve-baseline", async () => {
    const faults: Array<{ fault: StageFault; code: string }> = [
      { fault: "after-rewrap", code: "INJECTED_FAILURE" },
      { fault: "verification-failure", code: "CANDIDATE_VERIFICATION_FAILED" },
      { fault: "before-commit", code: "INJECTED_FAILURE" },
    ];
    for (const { fault, code } of faults) {
      const lab = await create();
      const token = await exported(lab);
      await unchangedRefusal(lab, stage(lab, token, 0, fault), code);
      assert.equal((await Effect.runPromise(stage(lab, token))).portableBytesPreserved, 2);
    }
  });
  await check("independent-snapshot-and-destination-baseline-change-refuse", async () => {
    for (const change of ["snapshot", "baseline"]) {
      const lab = await create();
      const token = await exported(lab);
      if (change === "snapshot") lab.modelSnapshotChange();
      else lab.modelBaselineChange();
      await unchangedRefusal(lab, stage(lab, token), "CONTEXT_MISMATCH");
    }
  });
  await check("one-single-process-model-candidate-wins-an-epoch", async () => {
    const lab = await create();
    const token = await exported(lab);
    const results = await Promise.all([0, 1].map(() => Effect.runPromise(Effect.result(stage(lab, token)))));
    assert.equal(results.filter(Result.isSuccess).length, 1);
    const refused = results.find(Result.isFailure);
    assert.ok(refused && Result.isFailure(refused));
    assert.equal(refused.failure.code, "REVISION_CONFLICT");
    assert.equal(lab.inspect().consumed, 1);
    assert.equal(lab.inspect().revision, 1);
  });
  await check("rollback-retains-consumed-transfer-id-and-never-activates", async () => {
    const lab = await create();
    const token = await exported(lab);
    await unchangedRefusal(lab, lab.activate(), "ACTIVATION_UNAVAILABLE");
    await Effect.runPromise(stage(lab, token));
    await unchangedRefusal(lab, lab.activate(), "ACTIVATION_UNAVAILABLE");
    await unchangedRefusal(lab, stage(lab, token, 1), "REPLAY_REFUSED");
    await unchangedRefusal(lab, lab.rollbackFixture(1), "APPROVAL_REQUIRED");
    await Effect.runPromise(lab.rollbackFixture(1, "candidate-discard-approved"));
    assert.equal(lab.inspect().candidatePresent, false);
    assert.equal(lab.inspect().consumed, 1);
    await unchangedRefusal(lab, stage(lab, await exported(lab), 2), "REPLAY_REFUSED");
    await unchangedRefusal(lab, lab.activate(), "ACTIVATION_UNAVAILABLE");
  });
  await check("lost-ephemeral-keys-never-regenerate-or-resume", async () => {
    const lab = await create();
    const token = await exported(lab);
    lab.modelKeyLoss();
    await unchangedRefusal(lab, stage(lab, token), "KEY_UNAVAILABLE");
    await unchangedRefusal(lab, lab.exportFixture("source-export-approved"), "KEY_UNAVAILABLE");
    await unchangedRefusal(lab, lab.activate(), "ACTIVATION_UNAVAILABLE");
  });
  await check("cancellation-before-publication-preserves-source-and-destination", async () => {
    const lab = await create();
    const token = await exported(lab);
    const before = lab.inspect();
    const gate = await Effect.runPromise(lab.holdBeforeFixtureCommit());
    const controller = new AbortController();
    const pending = Effect.runPromise(stage(lab, token), { signal: controller.signal }).then(
      () => true,
      () => false,
    );
    try {
      await Effect.runPromise(gate.entered.pipe(Effect.timeout(3000)));
      controller.abort();
      assert.equal(await pending, false);
      assert.deepEqual(lab.inspect(), before);
    } finally {
      controller.abort();
      await Effect.runPromise(gate.release);
    }
    assert.equal((await Effect.runPromise(stage(lab, token))).portableBytesPreserved, 2);
  });
  await check("late-context-or-key-loss-refuses-at-model-commit", async () => {
    for (const fault of ["baseline", "key-loss"]) {
      const lab = await create();
      const token = await exported(lab);
      const gate = await Effect.runPromise(lab.holdBeforeFixtureCommit());
      const pending = Effect.runPromise(Effect.result(stage(lab, token)));
      try {
        await Effect.runPromise(gate.entered.pipe(Effect.timeout(3000)));
        if (fault === "baseline") lab.modelBaselineChange();
        else lab.modelKeyLoss();
        const before = lab.inspect();
        await Effect.runPromise(gate.release);
        const outcome = await pending;
        assert.ok(Result.isFailure(outcome));
        assert.equal(outcome.failure.code, fault === "baseline" ? "CONTEXT_MISMATCH" : "KEY_UNAVAILABLE");
        assert.deepEqual(lab.inspect(), before);
      } finally {
        await Effect.runPromise(gate.release);
      }
    }
  });
  await check("public-errors-and-diagnostic-probe-never-return-canaries", async () => {
    const lab = await create();
    assert.throws(
      () => lab.diagnosticLeakProbe(),
      (error) => error instanceof CredentialLabFailure && error.code === "DIAGNOSTIC_REFUSED",
    );
    for (const value of groups) lab.assertSafeText(JSON.stringify(value));
  });
} finally {
  const report = {
    passed: groups.length === 17 && groups.every((group) => group.passed),
    groups,
    refusalCases,
    crypto: { library: "jose", version: "6.2.13", alg: "dir", enc: "A256GCM", nonextractableKeys: true },
    syntheticStoresOnly: true,
    plaintextCredentialFilesWritten: false,
    realCredentialStoresRead: false,
    realCredentialsExported: false,
    realCredentialsVerified: false,
    productionImportAvailable: false,
    keyDistributionVerified: false,
    sourceAuthenticationVerified: false,
    durableReplayImplemented: false,
    oneWriterFenceImplemented: false,
    fullAppStartupTested: false,
    fullMigrationComplete: false,
  };
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  for (const lab of labs) lab.assertSafeText(bytes);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "report.json"), bytes, { mode: 0o600 });
  assert.equal(await readFile(join(root, "report.json"), "utf8"), bytes);
  if (!report.passed) process.exitCode = 1;
}
