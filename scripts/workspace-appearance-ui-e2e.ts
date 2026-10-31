// Exercises the real App with offline IPC fixtures; no production host starts.
// bun scripts/workspace-appearance-ui-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/workspace-appearance-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/workspace-appearance-ui-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; failure?: string } = {
  passed: false,
  cases: [],
  pageErrors: [],
};
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
const shot = (name: string) => page.screenshot({ path: resolve(output, `${name}.png`) });
const rail = page.locator(".window-rail");
try {
  const url = new URL("/iframe.html?id=app--roster-workspace&viewMode=story", target);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.locator(".roster-row").first().waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await page.evaluate(() => document.fonts.ready);
  const desktopRail = await rail.boundingBox();
  assert.ok(desktopRail && desktopRail.width >= 180);
  assert.equal(await page.locator(".roster-row").count(), 3);
  assert.equal(await page.locator(".roster-row-asleep").count(), 1);
  const header = await page.locator(".conversation-header").boundingBox();
  assert.ok(header && header.height >= 64);
  await shot("roster-chat-1672");
  report.cases.push("Labelled desktop navigation, active/sleep roster and roomy chat render in the real App.");

  const editor = page.locator('.composer-editor-surface[contenteditable="true"]').first();
  await editor.fill("Keep this offline fixture draft.");
  const name = await page.locator(".conversation-title h1").innerText();
  await rail.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-page-title").waitFor();
  await shot("settings-1672");
  await rail.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".roster-row").first().waitFor();
  assert.equal(await page.locator(".conversation-title h1").innerText(), name);
  assert.equal(await editor.innerText(), "Keep this offline fixture draft.");
  report.cases.push("Settings and back retain the selected bot, roster view and unsent draft.");

  await rail.getByRole("button", { name: "Marketplace", exact: true }).click();
  await page.locator(".marketplace-nav-title").waitFor();
  await page.locator(".marketplace-nav").getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("tab", { name: "Discover", exact: true }).waitFor();
  await page.locator(".marketplace-app-card").first().waitFor();
  await shot("plugins-1672");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("heading", { name: "Connect a custom tool", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Create", exact: true }).getAttribute("aria-selected"), "true");
  await shot("create-1672");
  report.cases.push("Marketplace uses real catalog cards; the header Create action selects the existing setup view.");

  await rail.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".roster-row").first().waitFor();
  assert.equal(await editor.innerText(), "Keep this offline fixture draft.");
  await page.setViewportSize({ width: 1024, height: 768 });
  const compactRail = await rail.boundingBox();
  assert.ok(compactRail && compactRail.width <= 72);
  await rail.getByRole("button", { name: "Settings", exact: true }).focus();
  assert.equal(
    await rail.getByRole("button", { name: "Settings", exact: true }).evaluate((e) => e === document.activeElement),
    true,
  );
  await shot("roster-chat-1024");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  report.cases.push("At 1024px the navigation collapses to named icon controls without page overflow.");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
