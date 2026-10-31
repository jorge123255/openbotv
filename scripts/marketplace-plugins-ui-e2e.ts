// Drives the real shared Marketplace with offline connection fixtures.
// bun scripts/marketplace-plugins-ui-e2e.ts --url=http://localhost:6006
// Writes .openbot-build/marketplace-plugins-ui-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/marketplace-plugins-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/marketplace-plugins-ui-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; failure?: string } = {
  passed: false,
  cases: [],
  pageErrors: [],
};
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 880 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
async function open(story: string) {
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", `settings-marketplace--${story}`);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href);
  await page.getByRole("tab", { name: "Manage", exact: true }).waitFor();
}
try {
  await open("plugins-reconnect");
  const manage = page.getByRole("tab", { name: "Manage", exact: true });
  await page.waitForFunction(
    () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Manage",
  );
  await page.getByRole("button", { name: "Sign in to Notion again", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const row = page.getByRole("tabpanel").getByRole("button", { name: "Open Notion", exact: true });
  const handle = await row.elementHandle();
  assert.ok(handle);
  await page.waitForFunction((element) => document.activeElement === element, handle, { timeout: 5_000 });
  assert.equal(await row.evaluate((element) => element.closest("[inert]") === null), true);
  assert.equal(await manage.getAttribute("aria-selected"), "true");
  report.cases.push("Reconnect from Manage returns keyboard focus to its visible row after the action disappears.");

  await open("plugins-pending-connection");
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  await page.getByRole("tabpanel").getByRole("button", { name: "Open Notion", exact: true }).waitFor();
  const pending = page.getByRole("tabpanel").getByRole("button", { name: "Connect Notion", exact: true });
  await page.waitForFunction((element) => element?.getAttribute("aria-busy") === "true", await pending.elementHandle());
  report.cases.push("An idle catalog app with an in-flight host operation remains visible in Manage.");
  await page.getByRole("tab", { name: "Discover", exact: true }).click();
  await page.getByRole("tabpanel").getByRole("button", { name: "Open Notion", exact: true }).waitFor();
  report.cases.push("Switching back to Discover retains the pending connection.");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
