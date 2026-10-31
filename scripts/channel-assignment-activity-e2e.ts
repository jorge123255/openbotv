// Read-only task navigation in the real channel view with synthetic Storybook data.
// bun scripts/channel-assignment-activity-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelTask } from "@openbot/contracts/ipc";
import { chromium } from "playwright-core";
import { runStorybookA11y } from "./storybook-a11y";

declare global {
  interface Window {
    channelActivityFixture: {
      privateReads: number;
      writes: number;
      mutate: (state: ChannelTask["state"], recipient?: string) => Promise<void>;
    };
  }
}

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname));
assert.equal(origin.pathname, "/");
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const before = process.argv.includes("--before");
const output = resolve(import.meta.dirname, "../.openbot-build/channel-assignment-activity-e2e");
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  externalRequests: string[];
  screenshots: string[];
  failure?: string;
} = {
  passed: false,
  cases: [],
  pageErrors: [],
  externalRequests: [],
  screenshots: [],
};
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["http:", "https:"].includes(url.protocol) && url.origin !== origin.origin) {
    report.externalRequests.push(url.origin);
    return route.abort();
  }
  return route.continue();
});
const dialog = () => page.getByRole("dialog", { name: "Channel task", exact: true });
const viewTask = (title: string) =>
  page.getByRole("button", { name: `View task assigned to Chief: ${title}`, exact: true });
const counts = () =>
  page.evaluate(() => ({
    privateReads: window.channelActivityFixture.privateReads,
    writes: window.channelActivityFixture.writes,
  }));
async function shot(name: string) {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", timeout: 10000 });
  report.screenshots.push(path);
}
async function fresh(theme = "dark") {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const url = new URL("/iframe.html?id=channels-assignment-activity--assigned&viewMode=story", origin);
  url.searchParams.set("globals", `colorScheme:${theme}`);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("tab", { name: "Agents", exact: true }).click({ timeout: 60000 });
  await page
    .getByRole("button", { name: /^Assignment checks[, .]/ })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Message to channel", exact: true }).waitFor();
}
async function close() {
  await dialog().getByRole("button", { name: "Close", exact: true }).click();
  await dialog().waitFor({ state: "detached" });
}
try {
  await fresh();
  if (before) {
    const initial = await counts();
    await page.getByRole("button", { name: "Open chat with Chief", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Message Chief", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Message to channel", exact: true }).count(), 0);
    assert.equal(await dialog().count(), 0);
    assert.equal((await counts()).writes, initial.writes);
    await shot("before-private-chat");
    report.cases.push(
      "Current-main assignment opens the separate private chat, with no selected channel task or task activity.",
    );
  } else {
    const initial = await counts();
    await viewTask("Check the release status.").click();
    await dialog()
      .getByText("Waiting for a confirmed start. No result is recorded for this assignment.", { exact: false })
      .waitFor();
    await dialog().getByText("No work update has been recorded for this task yet.", { exact: true }).waitFor();
    await dialog().getByText("Work and replies stay in this channel.", { exact: false }).waitFor();
    await dialog().locator("summary").filter({ hasText: "Task reference" }).click();
    await dialog().getByText("queued-task", { exact: true }).waitFor();
    await shot("queued-task-dark");
    assert.deepEqual(await counts(), initial);
    const appStyle = await page.evaluate(() => {
      const root = document.querySelector(".channel-task-review");
      const text = root?.querySelector("[id$='-description']");
      if (!root || !text) throw new Error("Missing task dialog.");
      const c = getComputedStyle(text);
      const r = text.getBoundingClientRect();
      if (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== text)
        throw new Error("Task description is obscured.");
      return {
        color: c.color,
        fontSize: c.fontSize,
        fontWeight: c.fontWeight,
        background: getComputedStyle(root).backgroundColor,
      };
    });
    assert.match(appStyle.background, /^rgb\(/, "The dialog must have an opaque surface.");
    await close();
    assert.equal(await page.getByRole("textbox", { name: "Message to channel", exact: true }).count(), 1);
    report.cases.push(
      "Queued assignment opens its exact task and honest status, without private-chat reads, commands or provider work; the opaque dialog has no description occlusion.",
    );

    await viewTask("Inspect the release output.").click();
    await dialog().getByText("Reading the synthetic release output.", { exact: true }).waitFor();
    assert.equal(await dialog().getByText("Earlier review is complete.", { exact: true }).count(), 0);
    assert.deepEqual(await counts(), initial);
    await close();
    await viewTask("Review the earlier release.").click();
    await dialog().getByText("Earlier review is complete.", { exact: true }).waitFor();
    await dialog().getByText("This task is marked completed.", { exact: false }).waitFor();
    await close();
    report.cases.push(
      "Separate tasks for the same agent retain distinct status and activity; historical receipts show completion.",
    );

    await viewTask("Check the release status.").click();
    await page.evaluate(() => window.channelActivityFixture.mutate("running"));
    await dialog().getByRole("status").getByText("Running", { exact: true }).waitFor();
    assert.deepEqual(await counts(), initial);
    await close();
    report.cases.push(
      "An open task view follows a confirmed status change without closing or selecting the private chat.",
    );

    for (const state of ["running", "waiting", "paused", "failed", "completed", "cancelled"] as const) {
      await page.evaluate((state) => window.channelActivityFixture.mutate(state), state);
      await viewTask("Check the release status.")
        .getByText(state[0]?.toUpperCase() + state.slice(1), { exact: true })
        .waitFor();
      await viewTask("Check the release status.").click();
      await dialog()
        .getByRole("status")
        .getByText(state[0]?.toUpperCase() + state.slice(1), { exact: true })
        .waitFor();
      if (state === "failed")
        await dialog()
          .getByText("Synthetic provider session unavailable. No work was started.", { exact: true })
          .waitFor();
      assert.deepEqual(await counts(), initial);
      assert.equal(
        await dialog()
          .getByRole("button", { name: /Continue|Retry|Reassign|Cancel task/ })
          .count(),
        0,
      );
      await close();
    }
    await page.evaluate(() => window.channelActivityFixture.mutate("queued", "research"));
    await viewTask("Check the release status.").getByText("Assignment changed", { exact: true }).waitFor();
    await viewTask("Check the release status.").click();
    await dialog().getByText("Assignment checks · Research", { exact: true }).waitFor();
    assert.deepEqual(await counts(), initial);
    await close();
    report.cases.push(
      "Live state and reassignment update the task link; opening every state is read-only and offers no replay action.",
    );

    await fresh("light");
    const lightInitial = await counts();
    await page.setViewportSize({ width: 390, height: 844 });
    await viewTask("Inspect the release output.").click();
    await dialog().getByText("Reading the synthetic release output.", { exact: true }).waitFor();
    await shot("running-task-narrow-light");
    const lightAppStyle = await page.evaluate(() => {
      const root = document.querySelector(".channel-task-review");
      const text = root?.querySelector("[id$='-description']");
      if (!root || !text) throw new Error("Missing task dialog.");
      const c = getComputedStyle(text);
      return {
        color: c.color,
        fontSize: c.fontSize,
        fontWeight: c.fontWeight,
        background: getComputedStyle(root).backgroundColor,
      };
    });
    const bounds = await dialog().boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "detached" });
    assert.deepEqual(await counts(), lightInitial);
    report.cases.push("Narrow light task details fit the viewport and dismiss with Escape without action.");
    // Axe's virtual grid compares elements below the opaque App dialog and reports a false
    // overlap when those hidden transcript rows differ. Scan the identical shared component
    // and data on an empty canvas, keeping strict contrast assertions and App hit-testing above.
    for (const theme of ["dark", "light"]) {
      const url = new URL("/iframe.html?id=channels-assignment-activity--contrast&viewMode=story", origin);
      url.searchParams.set("globals", `colorScheme:${theme}`);
      await page.setViewportSize({ width: theme === "dark" ? 1440 : 390, height: 844 });
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
      await viewTask("Inspect the release output.").waitFor({ timeout: 60000 });
      const targetContrast = await runStorybookA11y(page, ".channel-assignment-target", {
        runOnly: { type: "rule", values: ["color-contrast"] },
      });
      assert.deepEqual(targetContrast.violations, []);
      assert.deepEqual(targetContrast.incomplete, []);
      await viewTask("Inspect the release output.").click();
      await dialog().getByText("Reading the synthetic release output.", { exact: true }).waitFor();
      const styles = await page.evaluate(() => {
        const root = document.querySelector(".channel-task-review");
        const text = root?.querySelector("[id$='-description']");
        if (!root || !text) throw new Error("Missing task dialog.");
        const c = getComputedStyle(text);
        return {
          color: c.color,
          fontSize: c.fontSize,
          fontWeight: c.fontWeight,
          background: getComputedStyle(root).backgroundColor,
        };
      });
      assert.deepEqual(
        styles,
        theme === "dark" ? appStyle : lightAppStyle,
        "Isolated contrast must use the App dialog's exact text and surface styles.",
      );
      const contrast = await runStorybookA11y(page, ".channel-task-review", {
        runOnly: { type: "rule", values: ["color-contrast"] },
      });
      if (contrast.violations.length || contrast.incomplete.length)
        writeFileSync(resolve(output, `contrast-${theme}.json`), JSON.stringify(contrast, null, 2));
      assert.deepEqual(contrast.violations, []);
      assert.deepEqual(contrast.incomplete, []);
      await close();
    }
    report.cases.push(
      "Identical shared task controls/dialog pass strict dark and narrow-light Axe contrast, with App-matched text/surface styles.",
    );
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await shot("failure").catch(() => undefined);
  throw error;
} finally {
  writeFileSync(resolve(output, before ? "before-report.json" : "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
