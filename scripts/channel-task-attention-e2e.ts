// Drives the real channel controller/view in isolated Storybook with synthetic stopped tasks.
// bun scripts/channel-task-attention-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CancelChannelTaskInput, RecoverChannelTaskInput } from "@openbot/contracts/ipc";
import { chromium, type Locator } from "playwright-core";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/channel-task-attention-e2e");
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  screenshots: string[];
  pageErrors: string[];
  externalRequests: string[];
  failure?: string;
} = { passed: false, cases: [], screenshots: [], pageErrors: [], externalRequests: [] };
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["http:", "https:"].includes(url.protocol) && url.origin !== target.origin) {
    report.externalRequests.push(url.origin);
    return route.abort();
  }
  return route.continue();
});
const summary = (text: string) => page.locator("summary").filter({ hasText: text });
const root = () => page.getByRole("group", { name: "Check the deployment status.", exact: true });
const review = () => page.getByRole("dialog", { name: "Review task work", exact: true });
const confirm = () => page.getByRole("alertdialog", { name: "Cancel this task?", exact: true });
const saved = () => page.evaluate(() => window.openbot.agent.readChannel({ channelId: "attention-channel" }));
const actions = () =>
  page.evaluate<
    ({ kind: "cancel"; input: CancelChannelTaskInput } | { kind: "recover"; input: RecoverChannelTaskInput })[]
  >("window.attentionFixture.actions");

async function shot(name: string) {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", timeout: 10_000 });
  report.screenshots.push(path);
}
async function fresh(story = "stopped", theme = "dark", width = 1440) {
  await page.setViewportSize({ width: Math.max(width, 1100), height: 1000 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", `channels-task-attention--${story}`);
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", `colorScheme:${theme}`);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (story === "older-host") {
    await page.setViewportSize({ width, height: 1000 });
    return;
  }
  await page.getByRole("tab", { name: "Agents", exact: true }).click({ timeout: 60_000 });
  await page
    .getByRole("button", { name: /^Release checks[, .]/ })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Message to channel", exact: true }).waitFor();
  await page.setViewportSize({ width, height: 1000 });
}
async function expand() {
  await summary("3 tasks need attention").click();
  await root().locator("summary").first().click();
}
async function waitDisabled(button: Locator, disabled: boolean) {
  const element = await button.elementHandle();
  assert.ok(element);
  await page.waitForFunction(
    ({ element, disabled }) => element instanceof HTMLButtonElement && element.disabled === disabled,
    { element, disabled },
  );
}
async function acknowledge() {
  await root().getByRole("button", { name: "Review work", exact: true }).click();
  await review().getByRole("button", { name: "I reviewed the work", exact: true }).click();
  await review().waitFor({ state: "detached" });
}

try {
  await fresh();
  if (process.argv.includes("--capture-baseline")) {
    await page.getByText("Stopped task for Chief", { exact: true }).waitFor();
    await shot("before-main");
    report.cases.push("Captured unchanged fork-main stopped-task panel with the same synthetic data.");
  } else {
    await summary("3 tasks need attention").waitFor();
    await shot("compact-dark");
    assert.equal(await root().getByRole("button", { name: "Continue", exact: true }).isVisible(), false);
    await expand();
    await page
      .getByRole("group", { name: "Inspect the deployment output.", exact: true })
      .locator("summary")
      .first()
      .click();
    await page.getByRole("group", { name: "Assign the follow-up review.", exact: true }).waitFor();
    assert.equal(await page.getByText("RESULT_UNCONFIRMED", { exact: false }).isVisible(), false);
    const child = page.getByRole("group", { name: "Inspect the deployment output.", exact: true });
    await child.locator("summary").filter({ hasText: "Event details" }).click();
    assert.equal(await child.getByText("RESULT_UNCONFIRMED", { exact: false }).isVisible(), true);
    await child.locator("summary").filter({ hasText: "Event details" }).click();
    const proceed = root().getByRole("button", { name: "Continue", exact: true });
    assert.equal(await proceed.isDisabled(), true);
    assert.equal((await actions()).length, 0);
    await root().getByRole("button", { name: "Review work", exact: true }).click();
    await review()
      .getByText("Created the deployment marker. Check the service before continuing.", { exact: true })
      .waitFor();
    assert.equal((await actions()).length, 0);
    await shot("review-dark");
    await review().getByRole("button", { name: "I reviewed the work", exact: true }).click();
    await waitDisabled(proceed, false);
    await root().getByRole("button", { name: "Reassign the stopped task of Chief", exact: true }).click();
    const choice = await page.getByRole("menuitem", { name: "Research", exact: true }).elementHandle();
    assert.ok(choice);
    await page.evaluate("window.attentionFixture.change()");
    await page.waitForFunction(
      (element) => !element.isConnected || element.getAttribute("aria-disabled") === "true",
      choice,
    );
    assert.equal((await actions()).length, 0);
    await page.keyboard.press("Escape");
    await waitDisabled(proceed, true);
    report.cases.push(
      "Separate task cards; raw events behind disclosure; review is read-only and a channel change invalidates acknowledgment.",
    );
    await acknowledge();
    await root().getByRole("button", { name: "Reassign the stopped task of Chief", exact: true }).click();
    await page.getByRole("menuitem", { name: "Research", exact: true }).click();
    await summary("1 task needs attention").waitFor();
    const recovered = await saved();
    assert.equal(recovered.tasks.find((task) => task.id === "root-task")?.ownerAgentId, "research");
    assert.equal(recovered.tasks.find((task) => task.id === "child-task")?.state, "queued");
    assert.equal(recovered.tasks.find((task) => task.id === "other-task")?.state, "paused");
    const recoveryActions = await actions();
    assert.equal(recoveryActions.length, 1);
    assert.equal(recoveryActions[0]?.kind, "recover");
    report.cases.push("Reviewed Reassign targets the selected branch; the separate task stays stopped.");

    await fresh();
    await expand();
    const beforeCancel = await saved();
    await root().getByRole("button", { name: "Cancel task", exact: true }).click();
    await confirm()
      .getByText("Cancellation does not undo work or external actions that already happened.", { exact: false })
      .waitFor();
    await shot("cancel-dark");
    await confirm().getByRole("button", { name: "Keep task", exact: true }).click();
    assert.equal((await actions()).length, 0);
    assert.deepEqual((await saved()).tasks, beforeCancel.tasks);
    await root().getByRole("button", { name: "Cancel task", exact: true }).click();
    await page.evaluate("window.attentionFixture.change()");
    await confirm().getByText("This work changed.", { exact: false }).waitFor();
    await confirm().getByRole("button", { name: "Cancel task", exact: true }).click();
    assert.equal((await actions()).length, 0);
    await confirm().getByRole("button", { name: "Close", exact: true }).click();
    report.cases.push(
      "Cancel states its subtree scope and no-undo semantics; Keep and stale confirmation make no cancellation request.",
    );
    await root().getByRole("button", { name: "Cancel task", exact: true }).click();
    await page.evaluate("window.attentionFixture.hold = true");
    await confirm().getByRole("button", { name: "Cancel task", exact: true }).click();
    await page.waitForFunction("window.attentionFixture.release !== null");
    assert.equal(await confirm().getByRole("button", { name: "Cancel task", exact: true }).isDisabled(), true);
    await page.evaluate("window.attentionFixture.release()");
    await summary("1 task needs attention").waitFor();
    const cancelled = await saved();
    assert.equal(cancelled.tasks.find((task) => task.id === "root-task")?.state, "cancelled");
    assert.equal(cancelled.tasks.find((task) => task.id === "child-task")?.state, "cancelled");
    assert.equal(cancelled.tasks.find((task) => task.id === "other-task")?.state, "paused");
    assert.equal((await actions()).length, 1);
    assert.ok(beforeCancel.messages.every((before) => cancelled.messages.some((after) => after.id === before.id)));
    assert.equal(cancelled.messages.filter((entry) => entry.message.text.includes("cancelled task")).length, 1);
    report.cases.push(
      "Pending confirmation blocks a second click; one cancel preserves history and stops only the selected branch.",
    );

    await fresh();
    await expand();
    await page.evaluate("window.attentionFixture.failAfterCancel = true");
    await root().getByRole("button", { name: "Cancel task", exact: true }).click();
    await confirm().getByRole("button", { name: "Cancel task", exact: true }).click();
    await summary("1 task needs attention").waitFor();
    assert.equal((await actions()).length, 1);
    assert.equal((await saved()).tasks.find((task) => task.id === "root-task")?.state, "cancelled");
    report.cases.push("Lost cancellation response refreshes durable state without automatic replay.");

    await fresh("earlier-activity");
    await expand();
    await root().getByRole("button", { name: "Review work", exact: true }).click();
    const acknowledgeButton = review().getByRole("button", { name: "I reviewed the work", exact: true });
    assert.equal(await acknowledgeButton.isDisabled(), true);
    await page.evaluate("window.attentionFixture.allowEarlier = true");
    await review().getByRole("button", { name: "Load earlier activity", exact: true }).click();
    await waitDisabled(acknowledgeButton, false);
    await review()
      .getByText("Created the deployment marker. Check the service before continuing.", { exact: true })
      .waitFor();
    assert.equal((await actions()).length, 0);
    report.cases.push(
      "Unloaded earlier activity blocks acknowledgment; loading it exposes prior work without sending a task action.",
    );

    await fresh("stopped", "light", 390);
    await expand();
    await shot("expanded-narrow-light");
    await root().getByRole("button", { name: "Review work", exact: true }).click();
    await shot("review-narrow-light");
    await review().getByRole("button", { name: "Close", exact: true }).click();
    await root().getByRole("button", { name: "Cancel task", exact: true }).click();
    await shot("cancel-narrow-light");
    await page.keyboard.press("Escape");
    await confirm().waitFor({ state: "detached" });
    report.cases.push(
      "Narrow light review/cancel controls remain usable; Escape dismisses confirmation without action.",
    );
    await fresh("older-host");
    await summary("3 tasks need attention").click();
    await root().locator("summary").first().click();
    await page.getByText("Update this host to use reviewed recovery and task cancellation.", { exact: true }).waitFor();
    assert.equal(await root().getByRole("button", { name: "Cancel task", exact: true }).isDisabled(), true);
    assert.equal(await root().getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
    report.cases.push("A host without the capability keeps history review and disables task mutations.");
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await shot("failure").catch(() => undefined);
  throw error;
} finally {
  writeFileSync(
    resolve(output, process.argv.includes("--capture-baseline") ? "baseline-report.json" : "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await browser.close();
}
