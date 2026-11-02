// Real App and shared feature fixtures with synthetic IPC only. Run in the isolated review VM or CI.
// Evidence has its own directory so an earlier review run remains unchanged.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/botai-workspace-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chromium";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/botai-whole-app-ui-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; screenshots: string[]; pageErrors: string[]; failure?: string } = {
  passed: false,
  cases: [],
  screenshots: [],
  pageErrors: [],
};
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
async function open(story: string, ready: string, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", story);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.locator(ready).first().waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await page.evaluate(() => document.fonts.ready);
}
async function shot(name: string) {
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
}
async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  assert.equal(
    await control.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.height > 0 && hit !== null && (element === hit || element.contains(hit));
    }),
    true,
    "The control must remain visible and receive pointer input.",
  );
  await control.focus();
  assert.equal(await control.evaluate((element) => element === document.activeElement), true);
}
try {
  for (const width of [1672, 1280, 1024]) {
    await open("app--whole-app-workspace", ".roster-row", width);
    const rail = page.locator(".window-rail");
    const nav = await rail.boundingBox();
    const frame = await page.locator(".app-frame").boundingBox();
    assert.ok(nav && frame && nav.width === width && nav.y + nav.height <= frame.y + 1);
    assert.equal(await page.locator(".roster-row").count(), 3);
    assert.equal(await page.locator(".roster-row-asleep").count(), 1);
    const editor = page.locator('.composer-editor-surface[contenteditable="true"]').first();
    await editor.fill("Whole-app offline fixture draft.");
    const selected = await page.locator(".conversation-title h1").innerText();
    const settings = rail.getByRole("button", { name: "Settings", exact: true });
    await reachable(settings);
    await settings.click();
    await page.locator(".settings-page-title").waitFor();
    await shot(`settings-${width}`);
    await rail.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".roster-row").first().waitFor();
    assert.equal(await page.locator(".conversation-title h1").innerText(), selected);
    assert.equal(await editor.innerText(), "Whole-app offline fixture draft.");
    await rail.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Schedule", exact: true }).click();
    await page.locator(".routine-planner").waitFor();
    await page.getByRole("tab", { name: "Day", exact: true }).click();
    await page.locator('.routine-planner[data-view="day"]').waitFor();
    const runs = page.locator(".routine-planner-day-view .routine-planner-entry-main");
    await runs.nth(27).waitFor();
    assert.ok((await runs.count()) >= 28, "The crowded day fixture must contain runs.");
    await reachable(runs.last());
    assert.equal(
      await page
        .locator(".routine-planner-body")
        .evaluate((element) => element.scrollHeight > element.clientHeight && element.scrollTop > 0),
      true,
      "The last run must be reached through the calendar scroll area.",
    );
    assert.equal(
      await page
        .locator(".routine-planner-body")
        .evaluate((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY)),
      true,
    );
    await shot(`schedule-${width}`);
    await rail.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Usage", exact: true }).click();
    await page.locator(".agent-usage-total-panel").waitFor();
    assert.equal(await page.locator(".agent-usage-totals > div:visible").count(), 8);
    await shot(`usage-${width}`);
    await rail.getByRole("button", { name: "Marketplace", exact: true }).click();
    await page.locator(".marketplace-nav-title").waitFor();
    await page.locator(".marketplace-nav").getByRole("button", { name: "Plugins", exact: true }).click();
    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    await page.getByRole("tab", { name: "Discover", exact: true }).click();
    await page.locator(".marketplace-app-card").first().waitFor();
    await shot(`plugins-${width}`);
    await rail.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".roster-row").first().waitFor();
    assert.equal(await editor.innerText(), "Whole-app offline fixture draft.");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(`chat-${width}`);
    report.cases.push(
      `${width}px: top navigation, settings, schedule, all usage metrics and Plugins remain reachable; selected chat and draft survive page changes.`,
    );
  }
  await open("window-pagerail--all-destinations", ".window-rail", 1024);
  for (const control of await page.locator(".window-rail button").all()) await reachable(control);
  await shot("navigation-all-destinations-1024");
  report.cases.push(
    "All pinned destinations, twelve custom account limits and fixed tools remain reachable by pointer and keyboard at 1024px.",
  );
  await open("auth-languagewheel--english", ".language-wheel-shell", 1024);
  await page.setViewportSize({ width: 1024, height: 600 });
  await reachable(page.locator(".language-wheel-continue"));
  await shot("language-choice-1024x600");
  report.cases.push("Language choice keeps Continue reachable in a short desktop window.");
  await open("tasks-tasks-page--default", ".tasks-page-row");
  await page.locator(".tasks-page-row").first().click();
  await page.locator(".tasks-panel").waitFor();
  await shot("task-detail");
  await page.keyboard.press("Escape");
  await page.locator(".tasks-panel").waitFor({ state: "hidden" });
  report.cases.push("Task cards still open the real task detail and Escape closes it.");

  await open("agents-usage--narrow", ".agent-usage-total-panel", 390);
  assert.equal(await page.locator(".agent-usage-totals > div:visible").count(), 8);
  await page.getByRole("button", { name: "View daily data", exact: true }).click();
  await page.getByRole("table", { name: "Daily usage and cost", exact: true }).waitFor();
  await page.waitForFunction(
    (element) => element === document.activeElement,
    await page.getByRole("table", { name: "Daily usage and cost", exact: true }).elementHandle(),
  );
  await shot("usage-narrow-daily");
  report.cases.push(
    "All eight totals remain available at 390px; View daily data still selects and focuses the daily table.",
  );

  const fixtures = [
    ["settings-settingsmodal--narrow", ".settings-page", 600],
    ["settings-serversettingsmodal--small-viewport", ".settings-page", 600],
    ["auth-accountlogin--invalid-code", ".account-login", 390],
    ["auth-accountlogin--sign-in", ".account-login", 1280],
    ["setup-firstrunflow--choice-narrow", ".first-run-choice", 390],
    ["settings-agentimport--review-narrow", ".agent-import label.agent-import-row", 390],
    ["settings-transfer--import-review", ".instance-transfer", 800],
    ["settings-vaultpanel--ready", ".vault-panel", 800],
    ["foundations-confirmdialog--with-error", '[role="alertdialog"]', 390],
    ["routines-calendar--many-routines", ".routine-planner-entry", 1024],
  ] as const;
  for (const [story, ready, width] of fixtures) {
    await open(story, ready, width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, story);
    await shot(story);
    report.cases.push(`${story}: real component rendered at ${width}px with no document overflow.`);
  }
  await open("auth-accountlogin--sign-in", ".account-login");
  const logo = page.getByRole("button", { name: "Animate BotAI logo", exact: true });
  await reachable(logo);
  await logo.press("Enter");
  assert.equal(await logo.evaluate((element) => element.getAnimations({ subtree: true }).length), 0);
  report.cases.push(
    "BotAI sign-in logo keeps its accessible keyboard control and has no animation under reduced motion.",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const splashUrl = new URL("/iframe.html?id=app-startupsplash--sequence&viewMode=story", target);
  await page.goto(splashUrl.href, { waitUntil: "domcontentloaded" });
  const splashEye = page.locator(".startup-splash .app-logo-botai-eye").first();
  await splashEye.waitFor();
  assert.equal(
    await splashEye.evaluate((element) => getComputedStyle(element).animationName.includes("startup-splash-eye-draw")),
    true,
  );
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await reachable(page.getByRole("button", { name: "Replay", exact: true }));
  report.cases.push("The BotAI startup intro still completes and calls onExited after readiness under normal motion.");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
