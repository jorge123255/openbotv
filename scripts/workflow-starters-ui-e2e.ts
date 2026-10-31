// Drives the real WorkflowCanvas and controller against a private synthetic Storybook host.
// No Electron profile, live workflow, provider, or external service is used.
// bun scripts/workflow-starters-ui-e2e.ts --url=http://localhost:6006 --browser-channel=chrome
// Writes .openbot-build/workflow-starters-ui-e2e/report.json and review screenshots.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { WorkflowStarterFixtureState } from "../src/renderer/stories/workflow-starter-fixture";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/workflow-starters-ui-e2e");
await mkdir(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  blockedExternalOrigins: string[];
  screenshots: string[];
  failure?: string;
  lastState?: WorkflowStarterFixtureState;
  failureMenus?: string[];
  failureMenuItems?: string[];
} = { passed: false, cases: [], pageErrors: [], blockedExternalOrigins: [], screenshots: [] };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let failureEvidence: (() => Promise<void>) | undefined;
try {
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  failureEvidence = async () => {
    report.failureMenus = await page.getByRole("menu").allTextContents();
    report.failureMenuItems = await page.getByRole("menuitem").allTextContents();
    const path = resolve(output, "failure.png");
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    report.screenshots.push(path);
  };
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== target.origin) {
      report.blockedExternalOrigins.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", "workflows--starter-regression");
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", "colorScheme:dark");
  await page.goto(url.href);
  const approval = page.getByRole("button", { name: "Try an approval flow", exact: true });
  const agent = page.getByRole("button", { name: "Build an agent review flow", exact: true });
  await approval.waitFor({ timeout: 60_000 });
  const state = async (): Promise<WorkflowStarterFixtureState> => {
    const value = await page.evaluate(async () => {
      const fixture = window.openbotWorkflowStarterFixture;
      if (!fixture) throw new Error("The synthetic workflow host is not ready.");
      return fixture.read();
    });
    report.lastState = value;
    return value;
  };
  const setReadOnly = async (value: boolean) =>
    page.evaluate((next) => {
      const fixture = window.openbotWorkflowStarterFixture;
      if (!fixture) throw new Error("The synthetic workflow host is not ready.");
      fixture.setReadOnly(next);
    }, value);
  const waitForNodes = async (count: number) =>
    page.waitForFunction((expected) => window.openbotWorkflowStarterFixture?.savedNodeCount() === expected, count);
  const openMenu = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menu").waitFor();
  };
  const screenshot = async (name: string) => {
    const path = resolve(output, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    report.screenshots.push(path);
  };
  const mod = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "Meta" : "Control"));
  const initial = await state();
  assert.equal(initial.current?.summary.id, "starter-regression");
  assert.equal(initial.current.graph.strokes.length, 1);
  assert.equal(initial.creates, 0);
  const existing = initial.workflows.find((workflow) => workflow.summary.id === "existing-workflow");
  assert.ok(existing);
  await screenshot("before-insertion-with-existing-stroke");

  await setReadOnly(true);
  await approval.waitFor({ state: "hidden" });
  assert.equal(await agent.count(), 0);
  assert.equal(await page.getByRole("button", { name: "Add trigger", exact: true }).count(), 0);
  await openMenu("Canvas regression");
  assert.equal(await page.getByRole("menuitem", { name: "New workflow", exact: true }).count(), 0);
  assert.equal(await page.getByRole("menuitem", { name: "Try an approval flow", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+Enter`);
  let observed = await state();
  assert.deepEqual(observed.current, initial.current);
  assert.equal(observed.changes.length, 0);
  assert.equal(observed.runs, 0);
  report.cases.push(
    "Read-only empty canvas exposes no starter/Add trigger/create-menu controls and keyboard Run makes no request",
  );

  await setReadOnly(false);
  await approval.waitFor();
  await approval.focus();
  await page.keyboard.press("Enter");
  await waitForNodes(5);
  const inserted = (await state()).current;
  assert.ok(inserted);
  assert.deepEqual(inserted.graph.strokes, initial.current.graph.strokes);
  assert.equal(inserted.graph.edges.length, 3);
  assert.deepEqual(
    inserted.graph.nodes.map((node) => node.kind),
    ["trigger", "prompt", "approval", "output", "note"],
  );
  const trigger = page.getByRole("article", { name: "Trigger", exact: true });
  assert.equal(
    await trigger.evaluate((element) => element.matches(":focus")),
    true,
    "Keyboard insertion must focus the first node",
  );
  report.cases.push(
    "Enter inserts the connected approval graph, preserves the existing stroke, and transfers keyboard focus to Trigger",
  );

  await page.keyboard.press(`${mod}+z`);
  await waitForNodes(0);
  observed = await state();
  assert.deepEqual(observed.current?.graph, initial.current.graph);
  await approval.waitFor();
  await page.keyboard.press(`${mod}+Shift+z`);
  await waitForNodes(5);
  assert.deepEqual((await state()).current?.graph, inserted.graph);
  report.cases.push(
    "One Undo removes all starter nodes/edges while preserving strokes; one Redo restores the same saved graph and identities",
  );

  await page.keyboard.press(`${mod}+z`);
  await waitForNodes(0);
  await agent.focus();
  await page.keyboard.press("Enter");
  await waitForNodes(6);
  const agentFlow = (await state()).current;
  assert.ok(agentFlow);
  assert.deepEqual(agentFlow.graph.strokes, initial.current.graph.strokes);
  assert.deepEqual(
    agentFlow.graph.nodes.map((node) => node.kind),
    ["trigger", "agent", "condition", "approval", "output", "note"],
  );
  assert.equal(agentFlow.graph.nodes.find((node) => node.kind === "agent")?.fields.agentId, "");
  assert.equal(agentFlow.graph.edges.find((edge) => edge.branch)?.branch, "yes");
  assert.equal(
    agentFlow.graph.nodes.some((node) => inserted.graph.nodes.some((old) => old.id === node.id)),
    false,
  );
  const agentNode = page.getByRole("article", { name: "Agent", exact: true });
  assert.equal(await agentNode.evaluate((element) => element.matches(":focus")), true);
  assert.equal(await page.getByRole("article", { name: "Prompt", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Choose agent", exact: true }).waitFor();
  await screenshot("agent-insertion-after-undo");
  report.cases.push(
    "An agent starter after Undo uses fresh identities, renders Agent instead of a stale Prompt, keeps strokes, and focuses Agent without selecting an agent",
  );

  await openMenu("Canvas regression");
  await page.getByRole("menuitem", { name: "Try an approval flow", exact: true }).click();
  await page.getByRole("main", { name: "Workflow canvas: Try an approval flow", exact: true }).waitFor();
  await waitForNodes(5);
  observed = await state();
  assert.equal(observed.workflows.length, 3);
  assert.equal(observed.creates, 1);
  assert.deepEqual(
    observed.workflows.find((workflow) => workflow.summary.id === "starter-regression"),
    agentFlow,
  );
  assert.deepEqual(
    observed.workflows.find((workflow) => workflow.summary.id === "existing-workflow"),
    existing,
  );
  assert.deepEqual(observed.current?.graph.strokes, []);
  report.cases.push(
    "Menu starter creates one separate workflow and preserves both existing workflows, graph revisions, and strokes",
  );

  const beforeLock = await state();
  await openMenu("Try an approval flow");
  await page.getByRole("menuitem", { name: "Build an agent review flow", exact: true }).waitFor();
  await setReadOnly(true);
  await page.getByRole("menuitem", { name: "Build an agent review flow", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("menuitem", { name: "New workflow", exact: true }).count(), 0);
  assert.equal(await page.getByRole("menuitem", { name: "Delete workflow", exact: true }).count(), 0);
  await page.getByRole("menu").press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Add node", exact: true }).count(), 0);
  const frozenTrigger = page.getByRole("article", { name: "Trigger", exact: true });
  const frozenRun = frozenTrigger.getByRole("button", { name: "Run workflow", exact: true });
  const frozenPort = frozenTrigger.getByRole("button", { name: "Text output", exact: true });
  await frozenRun.focus();
  assert.equal(await frozenRun.evaluate((element) => element.matches(":focus")), false);
  await frozenPort.focus();
  assert.equal(await frozenPort.evaluate((element) => element.matches(":focus")), false);
  // Force bypasses Playwright actionability, not browser inert hit testing. The click must make no request.
  await frozenRun.click({ force: true });
  await page.keyboard.press(`${mod}+Enter`);
  await page.keyboard.press(`${mod}+z`);
  observed = await state();
  assert.deepEqual(observed.current, beforeLock.current);
  assert.equal(observed.changes.length, beforeLock.changes.length);
  assert.equal(observed.creates, beforeLock.creates);
  assert.equal(observed.runs, 0);
  await screenshot("read-only-controls");
  report.cases.push(
    "A populated canvas made read-only removes an already-open menu's mutating actions; node Run/port controls cannot receive focus, a pointer click makes no request, and keyboard Run/Undo cannot mutate the host",
  );

  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  await failureEvidence?.();
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await browser?.close();
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${report.cases.length} cases; ${output}/report.json\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
