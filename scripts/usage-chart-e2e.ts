// Checks the real Usage panel in isolated Storybook, with mock analytics only.
// Start `bun run storybook --no-open`, then pass its URL:
// bun scripts/usage-chart-e2e.ts --url=http://localhost:6006 --label=after
// Writes a JSON report and screenshots to .openbot-build/usage-chart-e2e/<label>.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "Use an isolated local Storybook server.");
assert.equal(target.pathname, "/", "Pass only the Storybook origin.");
const label = argument("label") ?? "after";
assert.match(label, /^[a-z0-9-]+$/, "Use a simple report label.");
const output = resolve(import.meta.dirname, "../.openbot-build/usage-chart-e2e", label);
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; screenshots: string[]; failure?: string } = {
  passed: false,
  cases: [],
  pageErrors: [],
  screenshots: [],
};
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel), "Use Chrome or Chromium for the isolated fixture check.");
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => report.pageErrors.push(error.message));

async function screenshot(name: string) {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}

async function check(story: string, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", `agents-usage--${story}`);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href);
  await page.getByRole("heading", { name: "Usage Local host", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole("table", { name: "Usage by agent", exact: true }).waitFor();
  await screenshot(`${story}-cost`);
  const cost = page.getByRole("img", { name: "Daily estimated cost in USD by provider", exact: true });
  await cost.waitFor({ state: "visible", timeout: 10_000 });
  await cost.focus();
  await cost.press("ArrowRight");
  await page.getByRole("button", { name: "Usage metric Cost", exact: true }).click();
  await page.getByRole("option", { name: "Tokens", exact: true }).click();
  const tokens = page.getByRole("img", { name: "Daily tokens without cache reads by provider", exact: true });
  await tokens.waitFor({ state: "visible" });
  await screenshot(`${story}-tokens`);
  await page.getByRole("button", { name: "View daily data", exact: true }).click();
  await page.getByRole("table", { name: "Daily usage and cost", exact: true }).waitFor();
  report.cases.push(`${story}: cost chart, keyboard input, metric change, token chart and daily data`);
}

try {
  await check("usage");
  await check("daily-totals-only");
  await check("partial");
  await check("narrow", 390);
  await check("usage");
  assert.deepEqual(report.pageErrors, [], "The Usage fixtures must render without page errors.");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await screenshot("failure");
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
