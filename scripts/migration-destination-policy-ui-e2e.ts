// Actual Settings components and policy/preparation services; owned generated profile only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MigrationDestinationPolicyState, MigrationPreparationDestinationKind } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { chromium } from "playwright-core";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { MigrationDestinationPolicyService } from "../src/main/migration-destination-policy";
import { MigrationPreparationService } from "../src/main/migration-preparation";
import { readMigrationPreparationInventory } from "../src/main/migration-preparation-inventory";
import { MIGRATION_PREPARATION_JOURNAL } from "../src/main/migration-preparation-store";
import { decodeMigrationDestinationPolicyStateForRenderer } from "../src/preload/migration-destination-policy-decoding";
import { decodeMigrationPreparationStateForRenderer } from "../src/preload/migration-preparation-decoding";
import type { MigrationDestinationPolicyStoryRequest } from "../src/renderer/stories/migration-destination-policy-calls";
import type { MigrationPreparationStoryRequest } from "../src/renderer/stories/migration-preparation-calls";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(arg("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
const channel = arg("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/migration-destination-policy-ui-e2e");
await mkdir(output, { recursive: true, mode: 0o700 });
const fixture = await mkdtemp(join(output, "fixture-"));
const profile = join(fixture, "profile");
const database = new OpenBotDatabase(profile);
const preparation = new MigrationPreparationService({
  userDataPath: profile,
  readInventory: () => readMigrationPreparationInventory(() => database.connection),
});
const policy = new MigrationDestinationPolicyService({ preparation, platform: () => "darwin" });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  screenshots: string[];
  reactivity: { immutableUpdates: number; untrackedReads: number };
  policyCalls: number;
  destinationContacted: boolean;
  actualTLSVerified: boolean;
  destinationVerified: boolean;
  exportAvailable: boolean;
  restoreAvailable: boolean;
  activationAvailable: boolean;
} = {
  passed: false,
  cases: [],
  pageErrors: [],
  screenshots: [],
  reactivity: { immutableUpdates: 0, untrackedReads: 0 },
  policyCalls: 0,
  destinationContacted: false,
  actualTLSVerified: false,
  destinationVerified: false,
  exportAvailable: false,
  restoreAvailable: false,
  activationAvailable: false,
};
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let releaseHeld: () => void = () => {};
try {
  await Effect.runPromise(database.initialize());
  const canary = join(profile, "synthetic-credential-canary");
  await writeFile(canary, "PRIVATE_SYNTHETIC_POLICY_CANARY", { mode: 0o600 });
  database.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const sourceFiles = [database.path, `${database.path}-wal`, canary];
  const sourceHashes = await Promise.all(sourceFiles.map(digest));
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, reducedMotion: "reduce" });
  page.on("pageerror", () => report.pageErrors.push("page-error"));
  page.on("console", (message) => {
    if (message.text().includes("IMMUTABLE_UPDATE")) report.reactivity.immutableUpdates++;
    if (message.text().includes("STRICT_READ_UNTRACKED")) report.reactivity.untrackedReads++;
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin
      ? route.abort()
      : route.continue();
  });
  await page.exposeFunction(
    "__openbotMigrationPreparationInvoke",
    async (request: MigrationPreparationStoryRequest) => {
      const state =
        request.method === "getState"
          ? await Effect.runPromise(preparation.getState())
          : request.method === "prepare"
            ? await Effect.runPromise(preparation.prepare(request.input))
            : await Effect.runPromise(preparation.cancel(request.input));
      return decodeMigrationPreparationStateForRenderer(state);
    },
  );
  let failNext = false;
  let staleNext = false;
  let holdNext = false;
  let entered: () => void = () => {};
  await page.exposeFunction(
    "__openbotMigrationDestinationPolicyInvoke",
    async (request: MigrationDestinationPolicyStoryRequest) => {
      assert.equal(request.method, "getState");
      report.policyCalls++;
      if (failNext) {
        failNext = false;
        throw new Error("PRIVATE_SYNTHETIC_POLICY_ERROR");
      }
      let state = await Effect.runPromise(policy.getState());
      if (staleNext) {
        staleNext = false;
        assert.ok(state.preparation);
        state = { ...state, preparation: { ...state.preparation, revision: state.preparation.revision + 1 } };
      }
      if (holdNext) {
        holdNext = false;
        const held = new Promise<void>((resolveHeld) => {
          releaseHeld = resolveHeld;
        });
        entered();
        await held;
      }
      return decodeMigrationDestinationPolicyStateForRenderer(state);
    },
  );
  const url = new URL("/iframe.html", target);
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", "colorScheme:dark");
  const goto = async (id: string) => {
    url.searchParams.set("id", `settings-migration-preparation--${id}`);
    await page.goto(url.href);
  };
  const screenshot = async (name: string) => {
    const path = join(output, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    report.screenshots.push(path);
  };
  const heading = page.getByRole("heading", { name: "Approved migration policy", exact: true });
  const repository = page.getByText("jorge123255/openbotv", { exact: true });
  const reload = page.getByRole("button", { name: "Reload policy status", exact: true });
  const staleText = page.getByText(
    "The preparation plan changed. Reload the saved plan and policy status before you continue.",
    { exact: true },
  );
  const assertClosed = async () => {
    for (const name of ["Export", "Restore", "Activate"])
      assert.equal(await page.getByRole("button", { name, exact: true }).isEnabled(), false);
    const state: MigrationDestinationPolicyState = await Effect.runPromise(policy.getState());
    assert.equal(state.approvedReleaseTag, null);
    assert.equal(state.destinationVerified, false);
    assert.ok(Object.values(state.evidence).every((value) => value === false));
    assert.equal(state.unavailable.length, 5);
  };
  await goto("destination-policy");
  await page.getByRole("button", { name: "Save preparation plan", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Destination type\b/ }).click();
  await page.getByRole("option", { name: "Docker host", exact: true }).click();
  assert.equal(await heading.count(), 0);
  await screenshot("before-prepared-docker-policy-dark");
  await page.getByRole("button", { name: "Save preparation plan", exact: true }).click();
  await repository.waitFor();
  await heading.scrollIntoViewIfNeeded();
  await page.getByText("No release tag is approved yet", { exact: true }).waitFor();
  await page.getByText("Docker to Docker only", { exact: true }).waitFor();
  await page.getByText(".github/workflows/release.yml", { exact: true }).waitFor();
  for (const message of [
    "Approval of a specific release tag is unavailable.",
    "Release attestation verification is unavailable.",
    "Binding verified artifacts to the running source and destination is unavailable.",
    "An approved pairing record is unavailable.",
    "Authenticated source requests are unavailable.",
  ])
    await page.getByText(message, { exact: true }).waitFor();
  const state = await Effect.runPromise(policy.getState());
  assert.equal(state.applicability, "current");
  assert.equal(state.phase, "blocked");
  await assertClosed();
  await screenshot("approved-docker-policy-blocked-dark");
  await page.getByText("Authenticated source requests are unavailable.", { exact: true }).scrollIntoViewIfNeeded();
  await screenshot("missing-trust-providers-dark");
  report.cases.push(
    "Actual preparation and policy services show approved Docker scope, no tag, and five unavailable providers",
  );

  const journal = join(profile, MIGRATION_PREPARATION_JOURNAL);
  const journalBefore = await digest(journal);
  failNext = true;
  await reload.click();
  await page
    .getByText("OpenBot could not read the migration policy status. Reload the saved plan and try again.", {
      exact: true,
    })
    .waitFor();
  assert.equal((await page.locator("body").innerText()).includes("PRIVATE_"), false);
  await reload.click();
  await repository.waitFor();
  assert.equal(await digest(journal), journalBefore);
  report.cases.push("Policy reads preserve saved bytes; failures show fixed text and recover without a mutation");

  staleNext = true;
  await reload.click();
  await staleText.waitFor();
  assert.equal(await repository.count(), 0);
  await reload.click();
  await repository.waitFor();
  report.cases.push("A mismatched preparation revision hides policy details until a current read succeeds");

  const first = await Effect.runPromise(preparation.getState());
  assert.ok(first.plan);
  const heldEntered = new Promise<void>((resolveEntered) => {
    entered = resolveEntered;
  });
  holdNext = true;
  await reload.click();
  await heldEntered;
  await page.getByRole("button", { name: "Cancel preparation plan", exact: true }).click();
  await page.getByText("Preparation plan cancelled", { exact: true }).waitFor();
  assert.equal(await heading.count(), 0);
  await page.getByRole("button", { name: "Save a new preparation plan", exact: true }).click();
  await repository.waitFor();
  releaseHeld();
  await reload.click();
  await repository.waitFor();
  assert.equal(await staleText.count(), 0);
  const replacement = await Effect.runPromise(preparation.getState());
  assert.ok(replacement.plan && replacement.plan.id !== first.plan.id);
  await page.setViewportSize({ width: 560, height: 1000 });
  url.searchParams.set("globals", "colorScheme:light");
  await page.goto(url.href);
  await repository.waitFor();
  await heading.scrollIntoViewIfNeeded();
  await screenshot("approved-policy-narrow-light");
  report.cases.push("Cancelling hides the policy; a new plan ignores the disposed panel's delayed old response");

  const replace = async (destinationKind: MigrationPreparationDestinationKind) => {
    let current = await Effect.runPromise(preparation.getState());
    if (current.plan?.status === "prepared")
      current = await Effect.runPromise(
        preparation.cancel({ planId: current.plan.id, expectedRevision: current.revision }),
      );
    await Effect.runPromise(preparation.prepare({ destinationKind, expectedRevision: current.revision }));
  };
  for (const [kind, story] of [
    ["local-desktop", "local-destination-policy-unavailable"],
    ["other-server", "other-destination-policy-unavailable"],
  ] as const) {
    await replace(kind);
    const calls = report.policyCalls;
    await goto(story);
    await page.getByRole("button", { name: "Cancel preparation plan", exact: true }).waitFor();
    assert.equal(await heading.count(), 0);
    assert.equal(report.policyCalls, calls);
  }
  report.cases.push("Local-desktop and other-server plans make zero policy calls and show no Docker policy panel");

  await replace("docker-host");
  const windowsCalls = report.policyCalls;
  await goto("windows-unavailable");
  await page
    .getByText(
      "Saving preparation plans is not supported on Windows in this version. You can still reload an existing plan.",
      { exact: true },
    )
    .waitFor();
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
  assert.equal(await heading.count(), 0);
  assert.equal(report.policyCalls, windowsCalls);
  report.cases.push("A simulated Windows source makes zero policy calls; no native Windows support is claimed");

  const excludedCalls = report.policyCalls;
  await goto("host-metadata-rejected");
  await page.getByText("unavailable / darwin / host-unconfirmed", { exact: true }).waitFor();
  assert.equal(await heading.count(), 0);
  assert.equal(report.policyCalls, excludedCalls);
  await goto("remote-destination-policy-unavailable");
  await page.getByRole("tab", { name: "General", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Migration preparation", exact: true }).count(), 0);
  assert.equal(await heading.count(), 0);
  assert.equal(report.policyCalls, excludedCalls);
  report.cases.push("Unconfirmed host metadata and remote settings make zero policy calls");

  assert.deepEqual(await Promise.all(sourceFiles.map(digest)), sourceHashes);
  assert.equal(database.connection.prepare("SELECT count(*) AS total FROM projection_routine_runs").get()?.total, 0);
  assert.equal((await page.locator("body").innerText()).includes("PRIVATE_"), false);
  assert.deepEqual(report.pageErrors, []);
  assert.equal(report.reactivity.immutableUpdates, 0);
  report.cases.push(
    "Source database/WAL and canary stay byte-identical, no routine runs, page errors or immutable-update diagnostics",
  );
  report.passed = report.cases.length === 8;
} finally {
  releaseHeld();
  try {
    await browser?.close();
  } catch {
    report.passed = false;
    process.exitCode = 1;
  }
  try {
    database.close();
  } catch {
    report.passed = false;
    process.exitCode = 1;
  }
  try {
    await rm(fixture, { recursive: true, force: true });
  } catch {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (!report.passed) process.exitCode = 1;
