// Isolated Storybook with credential-free preview ports. No live Electron app or gateway.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const argument = (key: string) => process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6409");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname === "/");
const output = resolve(import.meta.dirname, "../.openbot-build/hermes-gateway-setup-ui-e2e");
await mkdir(output, { recursive: true });
const report: { passed: boolean; cases: string[]; externalRequests: string[]; pageErrors: string[] } = {
  passed: false,
  cases: [],
  externalRequests: [],
  pageErrors: [],
};
const channel = argument("browser-channel") ?? "chrome";
assert.ok(channel === "chrome" || channel === "chromium");
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["https:", "http:"].includes(url.protocol) && url.origin !== target.origin) {
    report.externalRequests.push(url.origin);
    return route.abort();
  }
  return route.continue();
});
async function story(name: string, width = 1000) {
  await page.setViewportSize({ width, height: 1000 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", `settings-hermes-gateways--${name}`);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href);
  await page.getByLabel("Gateway URL", { exact: true }).waitFor({ timeout: 60_000 });
}
async function text(value: string) {
  await page.getByText(value, { exact: true }).waitFor();
}
try {
  await story("setup");
  await text("No Hermes gateway has been added on this device.");
  await page.screenshot({ path: resolve(output, "before-setup.png"), fullPage: true, animations: "disabled" });
  await page.getByLabel("Gateway URL", { exact: true }).fill("https://gateway.example/hermes");
  await page.getByRole("button", { name: "Check gateway", exact: true }).click();
  await text("Gateway found");
  await page.getByRole("button", { name: "Sign in with browser", exact: true }).click();
  await text("Connection checked");
  const remember = page.getByRole("switch", { name: "Remember address and profile", exact: true });
  assert.ok(!(await remember.isChecked()), "Persistence is off by default.");
  assert.ok((await page.locator('input[type="password"]').count()) === 0, "The privileged UI has no password entry.");
  await page.getByLabel("Hermes profile", { exact: true }).click();
  await page.getByRole("option", { name: "Work", exact: true }).click();
  await remember.press("Space");
  await page.getByRole("button", { name: "Select profile", exact: true }).click();
  await text("Selected: work");
  await text("Address remembered");
  await text("Profile selected. Remote chat is not available yet.");
  await page.screenshot({
    path: resolve(output, "after-profile-selected.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({
    path: resolve(output, "profile-selected-narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await text("Sign-in required");
  await page.getByRole("button", { name: "Sign in with browser", exact: true }).click();
  await text("Connection checked");
  await page.getByRole("switch", { name: "Remember address and profile", exact: true }).press("Space");
  await page.getByRole("button", { name: "Select profile", exact: true }).click();
  await text("This session only");
  await page.getByRole("button", { name: "Remove gateway", exact: true }).click();
  await text("No Hermes gateway has been added on this device.");
  report.cases.push(
    "URL check, browser sign-in, profile choice, remember default/selection, disconnect/reconnect, unremember, remove",
  );
  await story("remembered", 390);
  await text("Sign-in required");
  await page.getByRole("button", { name: "Check gateway", exact: true }).last().click();
  await text("Gateway found");
  assert.ok(await page.getByRole("button", { name: "Sign in with browser", exact: true }).isEnabled());
  await page.screenshot({ path: resolve(output, "remembered-narrow.png"), fullPage: true, animations: "disabled" });
  report.cases.push("remembered gateway restores signed out and needs an explicit check before sign-in");
  await story("unsupported");
  await text("This gateway needs a password provider and native browser sign-in support.");
  assert.ok(await page.getByRole("button", { name: "Sign in with browser", exact: true }).isDisabled());
  report.cases.push("unsupported OAuth provider is shown and cannot start sign-in");
  await story("pending");
  await page.getByRole("button", { name: "Sign in with browser", exact: true }).click();
  await text("Finish sign-in in your browser…");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await text("Sign-in required");
  report.cases.push("pending browser sign-in can be cancelled without exposing credentials");
  assert.ok(report.externalRequests.length === 0, "The UI fixture makes no external network request.");
  assert.ok(report.pageErrors.length === 0, "The UI fixture has no runtime error.");
  report.passed = true;
} finally {
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
// Machine-readable: fixed descriptions and counts; no gateway or user credentials.
process.stdout.write(`${JSON.stringify({ passed: report.passed, cases: report.cases.length })}\n`);
