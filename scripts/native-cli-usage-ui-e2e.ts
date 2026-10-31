// Real shared rail/rings and consent dialog, Storybook fixtures only. No CLI/account requests.
// bun scripts/native-cli-usage-ui-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/native-cli-usage-ui-e2e");
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  externalRequests: string[];
  screenshots: string[];
  contrast: { surface: string; violations: number; incomplete: number }[];
  failure?: string;
} = { passed: false, cases: [], pageErrors: [], externalRequests: [], screenshots: [], contrast: [] };
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1050, height: 1150 }, reducedMotion: "reduce" });
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(60_000);
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin === target.origin || url.protocol === "data:") return route.continue();
  report.externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
  return route.abort();
});
async function story(mode: string, theme = "dark") {
  await page.goto(
    new URL(`/iframe.html?id=window-nativecliusage--${mode}&viewMode=story&globals=colorScheme:${theme}`, target).href,
  );
  await page.getByRole("button", { name: /Kimi CLI account quota/ }).waitFor();
}
async function shot(name: string) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true, animations: "disabled" });
  report.screenshots.push(`${name}.png`);
}
async function contrast(surface: string) {
  await page.addScriptTag({ path: resolve(import.meta.dirname, "../node_modules/axe-core/axe.min.js") });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const result = await page.evaluate<{ violations: number; incomplete: number }>(
    "axe.run('[role=dialog]', {runOnly:{type:'rule',values:['color-contrast']}}).then(result => ({violations: result.violations.length, incomplete: result.incomplete.length}))",
  );
  report.contrast.push({ surface, ...result });
  assert.equal(result.violations, 0);
  assert.equal(result.incomplete, 0);
}
try {
  await page.goto(new URL("/iframe.html?id=window-nativecliusage--before&viewMode=story", target).href);
  await page.getByRole("button", { name: "Agents", exact: true }).waitFor();
  await shot("before-rail");
  await story("fresh");
  await shot("fresh-rail");
  await page.getByRole("button", { name: /Kimi CLI account quota/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Kimi CLI usage", { exact: true }).waitFor();
  await dialog.getByText("5-hour: approximately 90% used", { exact: true }).waitFor();
  await dialog.getByText("Weekly: approximately 5% used", { exact: true }).waitFor();
  await dialog.getByText(/Monthly code share: approximately 5%/).waitFor();
  await dialog.getByText(/Extra Usage balance: 2.50 USD/).waitFor();
  await dialog.getByText(/not atomic/).waitFor();
  assert.ok(await dialog.getByRole("button", { name: "Read quota", exact: true }).isDisabled());
  await contrast("fresh dark dialog");
  await shot("fresh-dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Read quota", exact: true }).click();
  await page.getByText("reads=1, disconnects=0", { exact: true }).waitFor();
  assert.ok(await dialog.getByRole("button", { name: "Read quota", exact: true }).isDisabled());
  report.cases.push(
    "Fresh reported account windows, rounded values, wallet and monthly breakdown; each refresh requires consent",
  );
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Connect and read", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Devin CLI account quota/ }).click();
  await dialog.getByText(/no verified structured quota source/).waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  report.cases.push("Disconnect clears quota; Devin unavailable ring explains source gap without session percentages");
  await story("stale");
  await page.getByRole("button", { name: /Kimi CLI account quota, Stale/ }).click();
  await dialog.getByText("Stale · refresh to read current quota", { exact: true }).waitFor();
  await dialog.getByText("5-hour: quota unavailable", { exact: true }).waitFor();
  assert.equal(await dialog.getByText(/approximately .* used/).count(), 0);
  await shot("stale-dialog");
  report.cases.push("Stale values lose percentages and active rings");
  await story("unknown");
  await page.getByRole("button", { name: /Kimi CLI account quota/ }).click();
  await dialog.getByText("5-hour: quota unavailable", { exact: true }).waitFor();
  await dialog.getByText("A reset time was not reported for every window.", { exact: true }).waitFor();
  report.cases.push("Unknown values and reset times stay explicit");
  await story("expired");
  await page.getByRole("button", { name: /Kimi CLI account quota/ }).click();
  await dialog.getByText("5-hour: quota unavailable", { exact: true }).waitFor();
  await dialog.getByText("Weekly: approximately 5% used", { exact: true }).waitFor();
  report.cases.push("A passed reset clears only that window until an explicit new read");
  await story("connect", "light");
  await page.getByRole("button", { name: /Kimi CLI account quota/ }).click();
  const connect = dialog.getByRole("button", { name: "Connect and read", exact: true });
  assert.ok(await connect.isDisabled());
  await dialog.getByLabel("Kimi web bearer token").fill("mock-token-never-real");
  assert.ok(await connect.isDisabled());
  await dialog.getByRole("checkbox").check();
  await contrast("connect light dialog");
  await shot("connect-light");
  await connect.click();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
  await page.getByText("reads=1, disconnects=0", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Kimi CLI account quota/ }).click();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  assert.equal(await dialog.getByLabel("Kimi web bearer token").inputValue(), "");
  assert.ok(await dialog.getByRole("button", { name: "Connect and read", exact: true }).isDisabled());
  report.cases.push("Explicit connect requires token and consent; close/reopen discards draft token and consent");
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} catch (error) {
  await shot("failure");
  report.failure = error instanceof Error ? error.message : "Unknown UI fixture failure";
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
