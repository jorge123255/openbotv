// Real settings container/store and production coordinator, with a private generated profile.
// This exercises component/bridge integration; it does not bootstrap Electron or migrate data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { chromium } from "playwright-core";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { MigrationPreparationService } from "../src/main/migration-preparation";
import { readMigrationPreparationInventory } from "../src/main/migration-preparation-inventory";
import { MIGRATION_PREPARATION_JOURNAL } from "../src/main/migration-preparation-store";
import { decodeMigrationPreparationStateForRenderer } from "../src/preload/migration-preparation-decoding";
import type { MigrationPreparationStoryRequest } from "../src/renderer/stories/migration-preparation-calls";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(arg("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
const channel = arg("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/migration-preparation-ui-e2e");
await mkdir(output, { recursive: true, mode: 0o700 });
const fixture = await mkdtemp(join(output, "fixture-"));
const profile = join(fixture, "profile");
const database = new OpenBotDatabase(profile);
const report: { passed: boolean; cases: string[]; pageErrors: string[]; screenshots: string[] } = {
  passed: false,
  cases: [],
  pageErrors: [],
  screenshots: [],
};
const now = "2026-01-01T12:00:00.000Z";
const makeService = (journalProfile = profile) =>
  new MigrationPreparationService({
    userDataPath: journalProfile,
    readInventory: () => readMigrationPreparationInventory(() => database.connection),
    now: () => now,
  });
let service = makeService();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ channel, headless: true });
  await Effect.runPromise(database.initialize());
  const agent: AgentSummary = {
    id: "ui-fixture-agent",
    name: "PRIVATE_SYNTHETIC_NAME",
    title: "Synthetic",
    description: "PRIVATE_DESCRIPTION",
    notifications: false,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "ui-fixture-thread",
    workspacePath: join(fixture, "PRIVATE_WORKSPACE"),
    preview: "",
    updatedAt: now,
    avatarSeed: "fixture",
    avatarHue: null,
    avatarUrl: null,
  };
  database.replaceAgents("ui-fixture", [agent], "agents.updated");
  const conversation: ConversationSnapshot = {
    agentId: agent.id,
    threadId: agent.threadId,
    activeTurnId: null,
    revision: 0,
    messages: [
      {
        id: "ui-fixture-message",
        author: "user",
        text: "PRIVATE_SYNTHETIC_MESSAGE",
        createdAt: now,
        status: "completed",
      },
    ],
  };
  database.persistConversation(conversation, "conversation.saved");
  new AgentRoutineStore(database).create(
    {
      agentId: agent.id,
      name: "PRIVATE_ROUTINE",
      instruction: "Never execute",
      active: true,
      timezone: "Etc/UTC",
      schedule: { kind: "daily", time: "13:00" },
    },
    new Date(now),
  );
  const secretCanary = join(profile, "DO_NOT_READ_CREDENTIALS");
  await writeFile(secretCanary, "PRIVATE_SYNTHETIC_TOKEN", { mode: 0o600 });
  database.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const digest = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const sourceBefore = await digest(join(profile, "openbot.db"));
  const secretsBefore = await digest(secretCanary);
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin
      ? route.abort()
      : route.continue();
  });
  let losePrepareResponse = false;
  let prepareRequests = 0;
  await page.exposeFunction(
    "__openbotMigrationPreparationInvoke",
    async (request: MigrationPreparationStoryRequest) => {
      if (request.method === "prepare") prepareRequests++;
      const result =
        request.method === "getState"
          ? await Effect.runPromise(service.getState())
          : request.method === "prepare"
            ? await Effect.runPromise(service.prepare(request.input))
            : await Effect.runPromise(service.cancel(request.input));
      if (request.method === "prepare" && losePrepareResponse) {
        losePrepareResponse = false;
        throw new Error("Synthetic response lost after durable commit");
      }
      return decodeMigrationPreparationStateForRenderer(result);
    },
  );
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", "settings-migration-preparation--in-server-settings");
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", "colorScheme:dark");
  const screenshot = async (name: string) => {
    const path = resolve(output, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    report.screenshots.push(path);
  };
  const disabledActions = async () => {
    for (const name of ["Export", "Restore", "Activate"])
      assert.equal(await page.getByRole("button", { name, exact: true }).isEnabled(), false);
  };
  await page.goto(url.href);
  const prepare = page.getByRole("button", { name: "Save preparation plan", exact: true });
  await prepare.waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
  await disabledActions();
  await screenshot("before-plan-dark");
  await page.getByRole("button", { name: /^Destination type\b/ }).click();
  await page.getByRole("option", { name: "Docker host", exact: true }).click();
  await prepare.click();
  await page.getByText("Preparation plan saved", { exact: true }).waitFor();
  const saved = await Effect.runPromise(service.getState());
  assert.equal(saved.revision, 1);
  assert.equal(saved.plan?.destinationKind, "docker-host");
  assert.deepEqual(saved.plan?.inventory, { agents: 1, conversations: 1, messages: 1, attachments: 0, routines: 1 });
  for (const label of [
    "Agent records",
    "Conversation threads",
    "Message records",
    "Attachment records",
    "Agent routine definitions",
  ])
    await page.getByText(label, { exact: true }).waitFor();
  await disabledActions();
  await screenshot("after-saved-plan-dark");
  await page.getByRole("button", { name: "Activate", exact: true }).scrollIntoViewIfNeeded();
  await screenshot("blocked-actions-dark");
  report.cases.push(
    "Real settings container and store save a count-only Docker plan through the production coordinator/preload decoder",
  );
  service = makeService();
  await page.reload();
  await page.getByText("Preparation plan saved", { exact: true }).waitFor();
  assert.deepEqual(await Effect.runPromise(service.getState()), saved);
  await disabledActions();
  report.cases.push("New service instance and browser reload recover the same durable plan ID, revision and counts");
  await page.getByRole("button", { name: "Cancel preparation plan", exact: true }).click();
  await page.getByText("Preparation plan cancelled", { exact: true }).waitFor();
  service = makeService();
  await page.reload();
  await page.getByText("Preparation plan cancelled", { exact: true }).waitFor();
  assert.equal((await Effect.runPromise(service.getState())).revision, 2);
  losePrepareResponse = true;
  await page.getByRole("button", { name: "Save a new preparation plan", exact: true }).click();
  await page.getByText("Preparation plan saved", { exact: true }).waitFor();
  await page.getByRole("alert").waitFor();
  const recovered = await Effect.runPromise(service.getState());
  assert.equal(recovered.revision, 3);
  assert.notEqual(recovered.plan?.id, saved.plan?.id);
  await disabledActions();
  report.cases.push(
    "Cancel survives restart; a lost response is recovered by state read without replaying the committed preparation",
  );
  await page.setViewportSize({ width: 560, height: 1100 });
  await screenshot("recovered-plan-narrow-dark");
  url.searchParams.set("globals", "colorScheme:light");
  await page.goto(url.href);
  await page.getByText("Preparation plan saved", { exact: true }).waitFor();
  await disabledActions();
  await screenshot("saved-plan-narrow-light");
  await page.getByRole("button", { name: "Activate", exact: true }).scrollIntoViewIfNeeded();
  await screenshot("blocked-actions-narrow-light");
  const publicText = JSON.stringify(recovered) + (await page.locator("body").innerText());
  for (const canary of ["PRIVATE_", fixture, "ui-fixture-agent", "ui-fixture-thread", "ui-fixture-message"])
    assert.equal(publicText.includes(canary), false);
  assert.equal((await readFile(join(profile, MIGRATION_PREPARATION_JOURNAL))).includes(Buffer.from("PRIVATE_")), false);
  assert.equal(await digest(join(profile, "openbot.db")), sourceBefore);
  assert.equal(await digest(secretCanary), secretsBefore);
  assert.equal(database.connection.prepare("SELECT count(*) AS count FROM projection_routine_runs").get()?.count, 0);
  assert.equal(database.connection.prepare("SELECT active FROM projection_agent_routines").get()?.active, 1);
  report.cases.push(
    "Source database/credential-canary bytes stay unchanged; private content/paths stay out of the plan/UI; no routine run is created",
  );
  const requestsBeforeWindows = prepareRequests;
  const windowsProfile = join(fixture, "windows-preparation");
  service = makeService(windowsProfile);
  url.searchParams.set("id", "settings-migration-preparation--windows-unavailable");
  await page.goto(url.href);
  const windowsNotice = page.getByText(
    "Saving preparation plans is not supported on Windows in this version. You can still reload an existing plan.",
    { exact: true },
  );
  await windowsNotice.waitFor();
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
  assert.equal(await prepare.isEnabled(), false);
  assert.equal(await page.getByRole("button", { name: /^Destination type\b/ }).isEnabled(), false);
  const reload = page.getByRole("button", { name: "Reload saved plan", exact: true });
  assert.equal(await reload.isEnabled(), true);
  await reload.click();
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
  await disabledActions();
  assert.equal(prepareRequests, requestsBeforeWindows);
  assert.deepEqual(await Effect.runPromise(service.getState()), { revision: 0, plan: null });
  assert.equal((await readdir(fixture)).includes("windows-preparation"), false);
  assert.equal(await page.getByRole("alert").count(), 0);
  await screenshot("windows-save-unavailable-light");
  report.cases.push(
    "Simulated Windows source disables Save and destination choice with a specific notice; Reload works with no prepare IPC or journal creation",
  );
  // Seed only through the host's real coordinator to test reading an existing plan in Windows UI.
  // This does not claim native Windows publication support.
  const windowsSaved = await Effect.runPromise(
    service.prepare({ destinationKind: "docker-host", expectedRevision: 0 }),
  );
  assert.ok(windowsSaved.plan);
  const windowsCancelled = await Effect.runPromise(
    service.cancel({ planId: windowsSaved.plan.id, expectedRevision: 1 }),
  );
  url.searchParams.set("id", "settings-migration-preparation--windows-cancelled-plan");
  await page.goto(url.href);
  await windowsNotice.waitFor();
  await page.getByText("Preparation plan cancelled", { exact: true }).waitFor();
  const saveNew = page.getByRole("button", { name: "Save a new preparation plan", exact: true });
  assert.equal(await saveNew.isEnabled(), false);
  await reload.click();
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"));
  assert.equal(await saveNew.isEnabled(), false);
  assert.equal(prepareRequests, requestsBeforeWindows);
  assert.deepEqual(await Effect.runPromise(service.getState()), windowsCancelled);
  await disabledActions();
  await screenshot("windows-cancelled-plan-light");
  report.cases.push(
    "Simulated Windows source reloads a persisted cancelled plan and keeps Save a new preparation plan disabled without mutation IPC",
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} finally {
  try {
    await browser?.close();
  } finally {
    database.close();
    await rm(fixture, { recursive: true, force: true });
    await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}
