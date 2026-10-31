// Bundle only the real bootstrap and synthetic application/worker substitutes. Never build or
// launch the production application, Electron, a provider or a real profile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MainConfigFactory } from "electron-vite";
import { build, mergeConfig, type Plugin } from "vite";
import config from "../electron.vite.config";

const root = resolve(import.meta.dirname, "..");
const reportRoot = join(root, ".openbot-build/offline-startup-entry-e2e");
const entry = join(root, "src/main/startup-entry.ts");
const application = join(root, "src/main/index.ts");
const normalized = (path: string) => path.replaceAll("\\", "/");
const groups: Array<{ name: string; passed: boolean }> = [];
let fixture = "";
let refusalCases = 0;

async function check(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  // Machine-readable: fixed labels only; build errors and request data are not projected.
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}

async function bundle(kind: "valid" | "static-poison" | "eager-dynamic" | "unawaited" | "inlined") {
  assert.ok(config.main);
  const out = join(fixture, kind, "main");
  const shared = join(fixture, "shared.ts");
  const poison = join(fixture, "poison.mjs");
  const input = config.main.build?.rollupOptions?.input;
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  assert.equal(input.index, entry);
  assert.equal(input.application, application);
  const workerIds = new Set(
    Object.entries(input)
      .filter(([name]) => name !== "index" && name !== "application")
      .map(([, path]) => normalized(path)),
  );
  let applicationSubstituted = false;
  const workersSubstituted = new Set<string>();
  const substitute: Plugin = {
    name: "synthetic-entry-substitutes",
    enforce: "pre",
    resolveId(source) {
      if (source === "synthetic-entry-poison") return { id: pathToFileURL(poison).href, external: true };
    },
    async load(id) {
      const sourceId = normalized(id);
      if (sourceId === normalized(entry)) {
        const source = await readFile(entry, "utf8");
        if (kind === "static-poison") return `import 'synthetic-entry-poison';\n${source}`;
        if (kind === "eager-dynamic") return `void import('./index');\n${source}`;
        if (kind === "unawaited") return source.replace('await import("./index")', 'void import("./index")');
        return source;
      }
      if (sourceId === normalized(application)) {
        applicationSubstituted = true;
        return `import 'synthetic-entry-poison';
        import { appendFileSync } from 'node:fs';
        import { sharedPath } from ${JSON.stringify(shared)};
        await Promise.resolve();
        appendFileSync(process.env.OPENBOT_SYNTHETIC_MARKER, JSON.stringify({kind:'application',directory:__dirname,sharedPath})+'\\n');`;
      }
      if (workerIds.has(sourceId)) {
        workersSubstituted.add(sourceId);
        return `import { sharedPath } from ${JSON.stringify(shared)}; export { sharedPath };`;
      }
      // A resolver/config change must never turn this fixture into a real application build.
      if (sourceId.startsWith(`${normalized(root)}/src/`)) throw new Error("SYNTHETIC_ENTRY_SOURCE_NOT_SUBSTITUTED");
    },
  };
  const main = mergeConfig(config.main, {
    configFile: false,
    envFile: false,
    logLevel: "silent",
    plugins: [substitute],
    build: {
      outDir: out,
      emptyOutDir: true,
      ...(kind === "inlined" ? { rollupOptions: { output: { codeSplitting: false } } } : {}),
    },
  });
  const prepared = await new MainConfigFactory(
    main,
    { configFile: false, envFile: false, logLevel: "silent" },
    { root },
  ).build();
  await build(prepared);
  assert.equal(applicationSubstituted, true);
  assert.equal(workersSubstituted.size, workerIds.size);
  await writeFile(join(fixture, kind, "package.json"), '{"type":"module"}');
  return out;
}

function run(out: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const marker = join(fixture, "marker.jsonl");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(fixture, "home"),
    TMPDIR: join(fixture, "tmp"),
    OPENBOT_SYNTHETIC_MARKER: marker,
    ...extra,
  };
  return spawnSync(process.execPath, [join(out, "index.js"), ...args], {
    cwd: fixture,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

try {
  assert.equal(process.argv.length, 2);
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  fixture = await mkdtemp(join(reportRoot, "synthetic-"));
  await mkdir(join(fixture, "home"), { mode: 0o700 });
  await mkdir(join(fixture, "tmp"), { mode: 0o700 });
  await writeFile(
    join(fixture, "poison.mjs"),
    `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.OPENBOT_SYNTHETIC_MARKER,JSON.stringify({kind:'external-account-browser-provider-routine-sentinel'})+'\\n');`,
  );
  await writeFile(
    join(fixture, "shared.ts"),
    `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.OPENBOT_SYNTHETIC_MARKER,JSON.stringify({kind:'shared'})+'\\n'); export const sharedPath=__dirname;`,
  );
  const out = await bundle("valid");
  await check("normal-route-loads-application-and-shared-dependencies-once-at-main-root", async () => {
    const result = run(out, ["--openbot-server", "--user-data-dir=synthetic-unused"], {
      OPENBOT_SERVER: "1",
      OPENBOT_LOCAL_SERVER_CHILD: "synthetic-unused",
    });
    assert.equal(result.status, 0);
    const rows = (await readFile(join(fixture, "marker.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.kind === "application").length, 1);
    assert.equal(rows.filter((row) => row.kind === "shared").length, 1);
    assert.equal(rows.filter((row) => row.kind === "external-account-browser-provider-routine-sentinel").length, 1);
    assert.equal(rows.find((row) => row.kind === "application")?.directory, out);
    assert.equal(rows.find((row) => row.kind === "application")?.sharedPath, out);
    await rm(join(fixture, "marker.jsonl"));
  });
  await check("reserved-argv-and-environment-presence-refuse-before-any-poison-import", async () => {
    const requests: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [
      ...[
        "--openbot-offline-rehearsal",
        "--openbot-offline-rehearsal=",
        "--openbot-offline-rehearsal=0",
        "--openbot-offline-rehearsal=false",
        "--openbot-offline-rehearsal=synthetic-private-value",
        "--openbot-offline-rehearsal-profile=synthetic",
        "--OPENBOT_OFFLINE_REHEARSAL",
        "--no-openbot-offline-rehearsal",
        "---openbot-offline-rehearsal",
        " openbot-offline-rehearsal",
      ].map((arg) => ({ args: [arg], env: {} })),
      { args: ["--", "--openbot-offline-rehearsal"], env: {} },
      { args: ["--openbot-offline-rehearsal", "false", "--openbot-offline-rehearsal=0"], env: {} },
      ...["", "0", "false", "synthetic-private-value"].map((value) => ({
        args: [],
        env: { OPENBOT_OFFLINE_REHEARSAL: value },
      })),
      { args: [], env: { openbot_offline_rehearsal: "false" } },
      { args: [], env: { NO_OPENBOT_OFFLINE_REHEARSAL: "false" } },
      { args: [], env: { OPENBOT_OFFLINE_REHEARSAL_PROFILE: "synthetic-private-value" } },
      { args: ["--openbot-offline-rehearsal=false"], env: { OPENBOT_SERVER: "1", OPENBOT_OFFLINE_REHEARSAL: "0" } },
    ];
    for (const request of requests) {
      const result = run(out, request.args, request.env);
      assert.equal(result.status, 78);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "OPENBOT_OFFLINE_REHEARSAL_UNAVAILABLE\n");
      assert.ok(!(await readdir(fixture)).includes("marker.jsonl"));
      refusalCases++;
    }
  });
  for (const kind of ["static-poison", "eager-dynamic", "unawaited", "inlined"] as const) {
    await check(`bundle-guard-refuses-${kind}`, async () => {
      let refused = false;
      try {
        await bundle(kind);
      } catch (error) {
        assert.ok(error instanceof Error);
        if (kind === "unawaited") assert.match(error.message, /OPENBOT_OFFLINE_ENTRY_AWAIT_REQUIRED/);
        if (kind === "static-poison") assert.match(error.message, /OPENBOT_OFFLINE_ENTRY_GRAPH_INVALID/);
        if (kind === "eager-dynamic") assert.match(error.message, /OPENBOT_OFFLINE_ENTRY_GRAPH_INVALID/);
        if (kind === "inlined")
          assert.match(error.message, /OPENBOT_OFFLINE_ENTRY_GRAPH_INVALID|codeSplitting|multiple.*input|inline/i);
        refused = true;
      }
      assert.equal(refused, true);
    });
  }
  await check("missing-application-cannot-be-a-rehearsal-success-or-load-on-refusal", async () => {
    await rm(join(out, "application.js"));
    const missing = run(out, []);
    assert.equal(missing.error, undefined);
    assert.equal(missing.signal, null);
    assert.equal(typeof missing.status, "number");
    assert.notEqual(missing.status, 0);
    const refused = run(out, ["--openbot-offline-rehearsal"]);
    assert.equal(refused.status, 78);
    assert.equal(refused.stderr, "OPENBOT_OFFLINE_REHEARSAL_UNAVAILABLE\n");
    assert.ok(!(await readdir(fixture)).includes("marker.jsonl"));
  });
} catch {
  groups.push({ name: "fixture-setup", passed: false });
} finally {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const report = {
    passed: groups.length === 7 && groups.every((group) => group.passed),
    groups,
    refusalCases,
    actualApplicationImported: false,
    actualProviderExecuted: false,
    actualNetworkProbeSent: false,
    electronNativeStartupTested: false,
    fullAppRehearsalAvailable: false,
    productionFencing: false,
    fullMigrationComplete: false,
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  // Machine-readable: only fixed group results and counts.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}
