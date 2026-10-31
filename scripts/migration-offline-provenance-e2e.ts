// Public upstream vectors only. This harness never signs, creates a key or reads a user profile.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { bundleFromJSON, bundleToJSON } from "@sigstore/bundle";
import { EXTENSION_OID_SCT, RFC3161Timestamp, X509Certificate } from "@sigstore/core";
import { Effect, Result } from "effect";
import {
  type OfflineProvenanceFailure,
  OfflineProvenanceFixtureVerifier,
} from "../src/main/migration-offline-provenance";

declare const __PUBLIC_PROVENANCE_FIXTURES__: string;
declare const __PROVENANCE_CHILD_REPORT__: string;
declare const __PROVENANCE_DENIED_FILE__: string;
declare const __PROVENANCE_DENIED_WRITE__: string;

type Input = Parameters<OfflineProvenanceFixtureVerifier["verify"]>[0];
type Code = OfflineProvenanceFailure["code"];
type MutableFixtureRecord = { -readonly [Key in keyof DynamicRecord]: DynamicRecord[Key] };
const CHILD = "--isolated-child";
const FORMAT = "openbot-offline-provenance-acceptance-v1";
const EXPECTED_GROUPS = 12;
const FILES = [
  "trusted-root.fixture.sigstore",
  "message-signature.bundle.sigstore",
  "dsse.bundle.sigstore",
  "artifact.txt",
] as const;
const SIGNER = { issuer: "https://github.com/login/oauth", subjectAlternativeName: "brian@dehamer.com" };
const groups: Array<{ name: string; passed: boolean }> = [];
let successCount = 0;
let refusalCount = 0;
const refusalDiagnostics: Array<{ expected: readonly Code[]; actual: Code | "accepted"; label: string }> = [];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function record(value: unknown): MutableFixtureRecord {
  assert.ok(isDynamicRecord(value));
  return value;
}
function material(value: MutableFixtureRecord): MutableFixtureRecord {
  return record(value.verificationMaterial);
}
function entry(value: MutableFixtureRecord): MutableFixtureRecord {
  const entries = material(value).tlogEntries;
  assert.ok(Array.isArray(entries) && entries.length > 0);
  return record(entries[0]);
}
function edit(bytes: Uint8Array, mutate: (value: MutableFixtureRecord) => void, normalize = false): Buffer {
  const value = record(JSON.parse(Buffer.from(bytes).toString("utf8")));
  mutate(value);
  return Buffer.from(JSON.stringify(normalize ? bundleToJSON(bundleFromJSON(value)) : value));
}
function changedBase64(value: unknown): string {
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error("Public fixture field missing.");
  const bytes = Buffer.from(value, "base64");
  const last = bytes.at(-1);
  assert.ok(last !== undefined);
  bytes[bytes.length - 1] = last ^ 1;
  return bytes.toString("base64");
}
async function refused(
  operation: ReturnType<OfflineProvenanceFixtureVerifier["verify"]>,
  allowed: Code | readonly Code[],
  label = "fixed-refusal",
) {
  const result = await Effect.runPromise(Effect.result(operation));
  const codes = typeof allowed === "string" ? [allowed] : allowed;
  if (Result.isSuccess(result)) refusalDiagnostics.push({ expected: codes, actual: "accepted", label });
  assert.ok(Result.isFailure(result));
  if (!codes.includes(result.failure.code))
    refusalDiagnostics.push({ expected: codes, actual: result.failure.code, label });
  assert.ok(codes.includes(result.failure.code));
  assert.deepEqual(result.failure.toJSON(), { _tag: "OfflineProvenanceFailure", code: result.failure.code });
  refusalCount++;
}
async function accepted(
  service: OfflineProvenanceFixtureVerifier,
  input: Input,
  kind: "messageSignature" | "dsseEnvelope",
) {
  const result = await Effect.runPromise(service.verify(input));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.operations));
  assert.equal(result.scope, "public-fixture-only");
  assert.equal(result.kind, kind);
  assert.equal(result.signatureVerified, true);
  assert.equal(result.rootSha256, digest(input.root));
  assert.equal(result.bundleSha256, digest(input.bundle));
  assert.equal(result.artifactBound, input.artifact !== null);
  assert.equal(result.artifactSha256, input.artifact === null ? null : digest(input.artifact));
  assert.equal(result.productionTrusted, false);
  assert.equal(result.releaseApproved, false);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.destinationVerified, false);
  assert.deepEqual(result.operations, { export: false, restore: false, activate: false });
  successCount++;
}
async function denied(action: () => Promise<unknown>): Promise<void> {
  let captured = false;
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && error.code === "ERR_ACCESS_DENIED");
    captured = true;
  }
  assert.ok(captured);
}
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}

async function isolated() {
  const report = __PROVENANCE_CHILD_REPORT__;
  let fileHashes: string[] = [];
  try {
    assert.equal(process.argv.length, 3);
    assert.equal(process.versions.node.split(".")[0], "26");
    assert.ok(process.permission);
    const fixture = __PUBLIC_PROVENANCE_FIXTURES__;
    const [root, message, dsse, artifact] = await Promise.all(FILES.map((name) => readFile(join(fixture, name))));
    assert.ok(root && message && dsse && artifact);
    fileHashes = [root, message, dsse, artifact].map(digest);
    const service = new OfflineProvenanceFixtureVerifier();
    const messageInput: Input = { root, bundle: message, artifact, expectedSigner: SIGNER };
    const dsseInput: Input = { root, bundle: dsse, artifact: null, expectedSigner: SIGNER };

    await check(
      "Node26 permission model denies network child addons workers and unrelated filesystem access",
      async () => {
        assert.ok(process.permission);
        for (const scope of ["net", "child", "addons", "worker", "fs.read", "fs.write"])
          assert.equal(process.permission.has(scope), false);
        assert.equal(process.permission.has("fs.read", join(fixture, FILES[0])), true);
        assert.equal(process.permission.has("fs.write", report), true);
        await denied(() => readFile(__PROVENANCE_DENIED_FILE__));
        await denied(() => writeFile(__PROVENANCE_DENIED_WRITE__, "public capability probe"));
        await denied(
          () =>
            new Promise<void>((resolveDenied, rejectDenied) => {
              const socket = net.connect({ host: "127.0.0.1", port: 9 });
              socket.once("error", rejectDenied);
              socket.once("connect", () => {
                socket.destroy();
                rejectDenied(new Error("Network permission unexpectedly granted."));
              });
              socket.once("close", () => resolveDenied());
            }),
        );
      },
    );
    await check(
      "actual message signature and DSSE verify under public pinned root with all production gates false",
      async () => {
        assert.equal(digest(root), "ffedc2c317fedb9ea6ae8a054c7777f97042e362d745035918f9ba3b30d2038c");
        assert.equal(artifact.toString("utf8"), "hello, world!");
        await accepted(service, messageInput, "messageSignature");
        await accepted(service, dsseInput, "dsseEnvelope");
      },
    );
    await check("changed artifact signatures and DSSE payload refuse then original verification recovers", async () => {
      await refused(
        service.verify({ ...messageInput, artifact: Buffer.from("different public bytes") }),
        "verification-failed",
      );
      await refused(
        service.verify({
          ...messageInput,
          bundle: edit(message, (value) => {
            const signed = record(value.messageSignature);
            signed.signature = changedBase64(signed.signature);
          }),
        }),
        "verification-failed",
      );
      await refused(
        service.verify({
          ...dsseInput,
          bundle: edit(dsse, (value) => {
            const envelope = record(value.dsseEnvelope);
            envelope.payload = changedBase64(envelope.payload);
          }),
        }),
        "verification-failed",
      );
      await accepted(service, messageInput, "messageSignature");
    });
    await check(
      "signed checkpoints inclusion proofs and timestamp tampering fail cryptographic verification",
      async () => {
        const variants = [
          edit(message, (value) => {
            const checkpoint = record(record(entry(value).inclusionProof).checkpoint);
            assert.equal(typeof checkpoint.envelope, "string");
            if (typeof checkpoint.envelope !== "string" || checkpoint.envelope.length === 0)
              throw new Error("Public checkpoint missing.");
            checkpoint.envelope = `${String.fromCharCode(checkpoint.envelope.charCodeAt(0) ^ 1)}${checkpoint.envelope.slice(1)}`;
          }),
          edit(message, (value) => {
            const proof = record(entry(value).inclusionProof);
            const hashes = proof.hashes;
            assert.ok(Array.isArray(hashes) && hashes.length > 0);
            hashes[0] = changedBase64(hashes[0]);
          }),
          edit(message, (value) => {
            const timestamps = record(material(value).timestampVerificationData).rfc3161Timestamps;
            assert.ok(Array.isArray(timestamps));
            const timestamp = record(timestamps[0]);
            assert.equal(typeof timestamp.signedTimestamp, "string");
            if (typeof timestamp.signedTimestamp !== "string") throw new Error("Public timestamp missing.");
            const raw = Buffer.from(timestamp.signedTimestamp, "base64");
            const parsed = RFC3161Timestamp.parse(raw);
            const signature = parsed.signatureValue;
            const offset = raw.indexOf(signature);
            assert.ok(signature.length > 0 && offset >= 0 && raw.lastIndexOf(signature) === offset);
            const last = offset + signature.length - 1;
            const byte = raw[last];
            assert.ok(byte !== undefined);
            raw[last] = byte ^ 1;
            const changed = raw.toString("base64");
            assert.notEqual(changed, timestamp.signedTimestamp);
            timestamp.signedTimestamp = changed;
          }),
        ];
        for (const [index, bundle] of variants.entries())
          await refused(service.verify({ ...messageInput, bundle }), "verification-failed", `signed-evidence-${index}`);
      },
    );
    await check("missing transparency or timestamp evidence is refused without lowering thresholds", async () => {
      const variants = [
        edit(
          message,
          (value) => {
            material(value).tlogEntries = [];
          },
          true,
        ),
        edit(
          message,
          (value) => {
            material(value).timestampVerificationData = { rfc3161Timestamps: [] };
          },
          true,
        ),
        edit(message, (value) => {
          delete entry(value).inclusionProof;
        }),
      ];
      await refused(service.verify({ ...messageInput, bundle: variants[0] ?? Buffer.alloc(0) }), "verification-failed");
      await refused(service.verify({ ...messageInput, bundle: variants[1] ?? Buffer.alloc(0) }), "verification-failed");
      await refused(service.verify({ ...messageInput, bundle: variants[2] ?? Buffer.alloc(0) }), "verification-failed");
    });
    await check("certificate corruption and embedded SCT removal are certificate tamper refusals", async () => {
      await refused(
        service.verify({
          ...messageInput,
          bundle: edit(message, (value) => {
            const certificate = record(material(value).certificate);
            certificate.rawBytes = changedBase64(certificate.rawBytes);
          }),
        }),
        "verification-failed",
      );
      const removedSCT = edit(message, (value) => {
        const certificate = record(material(value).certificate);
        assert.equal(typeof certificate.rawBytes, "string");
        if (typeof certificate.rawBytes !== "string") throw new Error("Public certificate missing.");
        const parsed = X509Certificate.parse(Buffer.from(certificate.rawBytes, "base64"));
        const index = parsed.extensions.findIndex((extension) => extension.subs[0]?.toOID() === EXTENSION_OID_SCT);
        assert.ok(index >= 0);
        parsed.extensions.splice(index, 1);
        assert.equal(parsed.extSCT, undefined);
        certificate.rawBytes = parsed.root.toDER().toString("base64");
      });
      await refused(service.verify({ ...messageInput, bundle: removedSCT }), "verification-failed");
    });
    await check("unapproved roots and missing CT trust material fail the exact public root pin", async () => {
      for (const rootVariant of [
        Buffer.from("{}"),
        Buffer.concat([root, Buffer.from(" ")]),
        edit(root, (value) => {
          value.ctlogs = [];
        }),
      ])
        await refused(service.verify({ ...messageInput, root: rootVariant }), "root-pin-mismatch");
    });
    await check(
      "SAN regex confusion and approved fork issuer or identity substitutions never establish production trust",
      async () => {
        for (const expectedSigner of [
          { ...SIGNER, subjectAlternativeName: "email:brian@dehamer.com" },
          { ...SIGNER, subjectAlternativeName: "^brian@dehamer\\.com$" },
          { ...SIGNER, subjectAlternativeName: ".*@dehamer.com" },
          { ...SIGNER, issuer: "https://token.actions.githubusercontent.com" },
          {
            issuer: "https://token.actions.githubusercontent.com",
            subjectAlternativeName:
              "https://github.com/jorge123255/openbotv/.github/workflows/release.yml@refs/tags/v1.2.3",
          },
        ])
          await refused(service.verify({ ...messageInput, expectedSigner }), "identity-mismatch");
        await refused(
          service.verify({ ...messageInput, expectedSigner: { ...SIGNER, subjectAlternativeName: "" } }),
          "invalid-input",
        );
        await accepted(service, dsseInput, "dsseEnvelope");
      },
    );
    await check("DSSE cannot bind external bytes and message signatures require the artifact", async () => {
      await refused(service.verify({ ...dsseInput, artifact }), "unsupported-bundle");
      await refused(service.verify({ ...messageInput, artifact: null }), "unsupported-bundle");
      await accepted(service, dsseInput, "dsseEnvelope");
    });
    await check(
      "competing oneof fields permissive base64 and explicit SDK defaults are rejected before admission",
      async () => {
        const dsseObject = record(JSON.parse(dsse.toString("utf8")));
        for (const bundle of [
          edit(message, (value) => {
            value.dsseEnvelope = dsseObject.dsseEnvelope;
          }),
          edit(message, (value) => {
            const signed = record(value.messageSignature);
            signed.signature = `${signed.signature}%`;
          }),
          edit(message, (value) => {
            entry(value).integratedTime = "0";
          }),
        ])
          await refused(service.verify({ ...messageInput, bundle }), "invalid-input");
      },
    );
    await check("malformed duplicate oversized deep and ambiguous JSON produce fixed redacted failures", async () => {
      const stripped = message.toString("utf8").trimEnd();
      for (const bundle of [
        Buffer.from("{"),
        Buffer.from([0xc3, 0x28]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), message]),
      ])
        await refused(service.verify({ ...messageInput, bundle }), "verification-failed");
      const deep: MutableFixtureRecord = {};
      let cursor = deep;
      for (let depth = 0; depth < 26; depth++) {
        const next = {};
        cursor.nested = next;
        cursor = next;
      }
      for (const bundle of [
        Buffer.from(`${stripped.slice(0, -1)},"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}`),
        Buffer.from(`${stripped} `),
        Buffer.alloc(256 * 1024 + 1),
        Buffer.from(JSON.stringify(deep)),
        Buffer.from(JSON.stringify({ items: Array(65).fill(0) })),
        Buffer.from('{"__proto__":{}}'),
        Buffer.from('{"constructor":{}}'),
        Buffer.from('{"prototype":{}}'),
      ])
        await refused(service.verify({ ...messageInput, bundle }), "invalid-input");
    });
    await check(
      "shared buffers oversized inputs and invalid identity bounds refuse while fixture files stay unchanged",
      async () => {
        for (const name of ["root", "bundle", "artifact"] as const) {
          const original = name === "root" ? root : name === "bundle" ? message : artifact;
          const shared = new Uint8Array(new SharedArrayBuffer(original.byteLength));
          shared.set(original);
          await refused(service.verify({ ...messageInput, [name]: shared }), "invalid-input");
        }
        await refused(
          service.verify({ ...messageInput, artifact: new Uint8Array(16 * 1024 * 1024 + 1) }),
          "invalid-input",
        );
        await refused(service.verify({ ...messageInput, root: new Uint8Array(256 * 1024 + 1) }), "invalid-input");
        await refused(
          service.verify({ ...messageInput, expectedSigner: { ...SIGNER, issuer: "x".repeat(2049) } }),
          "invalid-input",
        );
        assert.deepEqual([root, message, dsse, artifact].map(digest), fileHashes);
        assert.deepEqual(
          await Promise.all(FILES.map(async (name) => digest(await readFile(join(fixture, name))))),
          fileHashes,
        );
        await accepted(service, messageInput, "messageSignature");
      },
    );
  } catch {
    groups.push({ name: "restricted-fixture-or-harness-setup", passed: false });
  }
  const passed = groups.length === EXPECTED_GROUPS && groups.every((group) => group.passed);
  try {
    await writeFile(
      report,
      `${JSON.stringify(
        {
          format: FORMAT,
          passed,
          expectedGroups: EXPECTED_GROUPS,
          groups,
          successCount,
          refusalCount,
          refusalDiagnostics,
          publicFixturesOnly: true,
          actualSDKCrypto: successCount >= 2,
          networkPermission: false,
          childProcessPermission: false,
          addonPermission: false,
          workerPermission: false,
          sourceFilesChanged: false,
          privateKeysRead: false,
          keysGenerated: false,
          signaturesCreated: false,
          productionTrusted: false,
          releaseApproved: false,
          runtimeVerified: false,
          destinationVerified: false,
          operations: { export: false, restore: false, activate: false },
          limits: [
            "Public historical fixture root only",
            "DSSE does not bind an external artifact",
            "SCT removal also invalidates certificate signature",
            "Node permissions constrain trusted code and are not an OS sandbox",
            "No approved fork release or OCI/runtime verification",
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
  } catch {
    process.stdout.write("FAIL confined-report-write\n");
    process.exitCode = 1;
  }
  if (!passed) process.exitCode = 1;
}

async function directory(path: string, privateMode: boolean) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && error.code === "EEXIST");
  }
  const info = await lstat(path);
  assert.ok(info.isDirectory() && (!process.getuid || info.uid === process.getuid()));
  if (privateMode) assert.equal(info.mode & 0o077, 0);
  return info;
}
async function boundedFile(path: string, maximum: number, privateMode: boolean) {
  const before = await lstat(path);
  assert.ok(
    before.isFile() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= maximum &&
      (!process.getuid || before.uid === process.getuid()),
  );
  if (privateMode) assert.equal(before.mode & 0o077, 0);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(
      info.isFile() &&
        info.nlink === 1 &&
        info.dev === before.dev &&
        info.ino === before.ino &&
        info.size === before.size,
    );
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    assert.ok(
      length === info.size &&
        length <= maximum &&
        after.size === info.size &&
        after.nlink === 1 &&
        after.dev === info.dev &&
        after.ino === info.ino,
    );
    return { bytes: bytes.subarray(0, length), info };
  } finally {
    await handle.close();
  }
}
async function publishReport(path: string, bytes: Buffer) {
  let previous: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    previous = await lstat(path);
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
  if (previous) {
    assert.ok(
      previous.isFile() &&
        previous.nlink === 1 &&
        previous.size <= 64 * 1024 &&
        (!process.getuid || previous.uid === process.getuid()) &&
        (previous.mode & 0o077) === 0,
    );
    const old = await boundedFile(path, 64 * 1024, true);
    assert.ok(old.info.ino === previous.ino && old.info.dev === previous.dev);
    assert.equal(record(JSON.parse(old.bytes.toString("utf8"))).format, FORMAT);
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (previous ? 0 : constants.O_EXCL),
    0o600,
  );
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.nlink === 1 && (!process.getuid || info.uid === process.getuid()));
    if (previous) assert.ok(info.ino === previous.ino && info.dev === previous.dev);
    await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function parent() {
  const workspace = resolve(import.meta.dirname, "..");
  const output = join(workspace, ".openbot-build", "migration-offline-provenance");
  let run = "";
  let failed = false;
  let summary: DynamicRecord | null = null;
  let outputIdentity: Awaited<ReturnType<typeof lstat>> | null = null;
  let runIdentity: Awaited<ReturnType<typeof lstat>> | null = null;
  let activeChild: ChildProcess | null = null;
  let activeClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let childReaped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    assert.equal(process.argv.length, 2);
    assert.equal(process.versions.node.split(".")[0], "26");
    const workspaceInfo = await lstat(workspace);
    assert.ok(workspaceInfo.isDirectory());
    await directory(join(workspace, ".openbot-build"), false);
    outputIdentity = await directory(output, true);
    run = await mkdtemp(join(output, "run-"));
    runIdentity = await lstat(run);
    assert.ok(runIdentity.isDirectory() && (runIdentity.mode & 0o077) === 0);
    const bundle = join(run, "acceptance.mjs");
    const report = join(run, "report.json");
    const deniedFile = join(run, "denied-public-canary");
    const deniedWrite = join(run, "denied-write");
    await writeFile(deniedFile, "PUBLIC_PERMISSION_CANARY", { mode: 0o600 });
    const fixtureSource = join(workspace, "scripts", "fixtures", "migration-provenance");
    for (const path of [join(workspace, "scripts"), join(workspace, "scripts", "fixtures"), fixtureSource]) {
      const info = await lstat(path);
      assert.ok(info.isDirectory());
    }
    const stagedFixtures = join(run, "fixtures");
    await mkdir(stagedFixtures, { mode: 0o700 });
    const pins = [
      "ffedc2c317fedb9ea6ae8a054c7777f97042e362d745035918f9ba3b30d2038c",
      "b618039fb79226d357daef0fc95f0be06f9aa6fa1c6bc8e93c0e3b3a1d043e08",
      "ece731a4721ac9b1f940afef4c503c4492e317f30cfed66e19c1e8adfd1e1568",
      digest(Buffer.from("hello, world!")),
    ];
    for (const [index, name] of FILES.entries()) {
      const source = await boundedFile(join(fixtureSource, name), 256 * 1024, false);
      assert.equal(digest(source.bytes), pins[index]);
      await writeFile(join(stagedFixtures, name), source.bytes, { mode: 0o600, flag: "wx" });
    }
    const { build } = await import("esbuild");
    await build({
      entryPoints: [import.meta.filename],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      external: ["esbuild"],
      logLevel: "silent",
      sourcemap: false,
      banner: {
        js: 'import { createRequire as makeHarnessRequire } from "node:module"; const require = makeHarnessRequire(import.meta.url);',
      },
      define: {
        __PUBLIC_PROVENANCE_FIXTURES__: JSON.stringify(stagedFixtures),
        __PROVENANCE_CHILD_REPORT__: JSON.stringify(report),
        __PROVENANCE_DENIED_FILE__: JSON.stringify(deniedFile),
        __PROVENANCE_DENIED_WRITE__: JSON.stringify(deniedWrite),
      },
    });
    const args = [
      "--permission",
      `--allow-fs-read=${bundle}`,
      `--allow-fs-read=${stagedFixtures}`,
      `--allow-fs-write=${report}`,
      "--max-old-space-size=128",
      bundle,
      CHILD,
    ];
    const child = spawn(process.execPath, args, {
      cwd: run,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", LANG: "C", TZ: "UTC", NODE_NO_WARNINGS: "1" },
    });
    activeChild = child;
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let childError = false;
    let outputExceeded = false;
    let terminationRequested = false;
    const terminate = () => {
      if (!terminationRequested) {
        terminationRequested = true;
        child.kill("SIGKILL");
      }
    };
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed) => {
      child.once("error", () => {
        childError = true;
      });
      child.once("close", (code, signal) => {
        childReaped = true;
        resolveClosed({ code, signal });
      });
    });
    activeClosed = closed;
    child.stdout.on("data", (bytes: Buffer) => {
      if (outputExceeded) return;
      const remaining = 8192 - stdout.length;
      stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
      if (bytes.length > remaining) {
        outputExceeded = true;
        terminate();
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      if (outputExceeded) return;
      stderrBytes = Math.min(8193, stderrBytes + bytes.length);
      if (stderrBytes > 8192) {
        outputExceeded = true;
        terminate();
      }
    });
    timer = setTimeout(terminate, 30_000);
    const result = await closed;
    clearTimeout(timer);
    // The child emits only fixed group names. Drop stderr; it can contain parser or SDK causes.
    for (const line of stdout.toString("utf8").split("\n"))
      if (/^(?:pass|FAIL) [A-Za-z0-9 -]+$/.test(line)) process.stdout.write(`${line}\n`);
    summary = record(JSON.parse((await boundedFile(report, 64 * 1024, true)).bytes.toString("utf8")));
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(childError, false);
    assert.equal(outputExceeded, false);
    assert.equal(childReaped, true);
    assert.equal(stderrBytes, 0);
    assert.equal(summary.passed, true);
    assert.equal(summary.expectedGroups, EXPECTED_GROUPS);
    assert.ok(Array.isArray(summary.groups) && summary.groups.length === EXPECTED_GROUPS);
  } catch {
    failed = true;
    process.stdout.write("FAIL confined-harness-or-child\n");
  } finally {
    if (timer) clearTimeout(timer);
    if (activeChild && activeClosed && !childReaped) {
      activeChild.kill("SIGKILL");
      await activeClosed;
    }
    try {
      if (activeChild) assert.equal(childReaped, true);
      if (run && outputIdentity && runIdentity) {
        const currentOutput = await lstat(output);
        const currentRun = await lstat(run);
        assert.ok(
          currentOutput.isDirectory() &&
            currentOutput.ino === outputIdentity.ino &&
            currentOutput.dev === outputIdentity.dev,
        );
        assert.ok(currentRun.isDirectory() && currentRun.ino === runIdentity.ino && currentRun.dev === runIdentity.dev);
        await rm(run, { recursive: true, force: true });
      }
    } catch {
      failed = true;
      process.stdout.write("FAIL owned-bundle-cleanup\n");
    }
    try {
      assert.ok(outputIdentity);
      const current = await lstat(output);
      assert.ok(current.isDirectory() && current.ino === outputIdentity.ino && current.dev === outputIdentity.dev);
      await publishReport(
        join(output, "report.json"),
        Buffer.from(
          `${JSON.stringify(
            {
              ...(summary ?? { format: FORMAT, groups: [] }),
              format: FORMAT,
              passed: !failed && summary?.passed === true,
              confinedHarnessFailed: failed,
            },
            null,
            2,
          )}\n`,
        ),
      );
    } catch {
      failed = true;
      process.stdout.write("FAIL safe-report-publication\n");
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[2] === CHILD) await isolated();
else await parent();
