// Drives the real Storybook accessibility addon and Axe with a held scan and synthetic controls.
// bun scripts/storybook-a11y-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AxeResults, CheckHelper } from "axe-core";
import { chromium } from "playwright-core";
import { runStorybookA11y } from "./storybook-a11y";

declare global {
  interface Window {
    a11yQueueFixture: {
      release: (() => void) | null;
      resets: number;
      completed: string[];
      errors: string[];
    };
  }
}

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/storybook-a11y-e2e");
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  externalRequests: string[];
  directRunFailure?: string;
  failure?: string;
} = { passed: false, cases: [], pageErrors: [], externalRequests: [] };
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["http:", "https:"].includes(url.protocol) && url.origin !== target.origin) {
    report.externalRequests.push(url.origin);
    return route.abort();
  }
  return route.continue();
});

const contrast = { runOnly: { type: "rule", values: ["color-contrast"] } };
try {
  await page.goto(new URL("/iframe.html?id=conversation-account-quota--warning&viewMode=story", target).href);
  await page.getByRole("region", { name: "Ollama Cloud usage", exact: true }).waitFor({ timeout: 60_000 });
  await runStorybookA11y(page, ".quota-notice", { runOnly: { type: "rule", values: ["color-contrast"] } });
  await page.evaluate(() => {
    const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (!channel) throw new Error("Missing Storybook channel.");
    window.a11yQueueFixture = { release: null, resets: 0, completed: [], errors: [] };
    const button = document.createElement("button");
    button.id = "axe-queue-pass";
    button.textContent = "Readable fixture";
    button.style.cssText = "position:fixed;top:0;left:0;z-index:10000;color:#000;background:#fff;font-size:20px";
    document.body.append(button);
    const failing = button.cloneNode(true);
    if (!(failing instanceof HTMLElement)) throw new Error("Missing contrast fixture.");
    failing.id = "axe-queue-fail";
    failing.style.cssText = "position:fixed;top:40px;left:0;z-index:10000;color:#888;background:#999;font-size:20px";
    document.body.append(failing);
    channel.on("storybook/a11y/result", (result: AxeResults, id: string) => {
      window.a11yQueueFixture.completed.push(id);
      if (id === "held-fixture" && (result.violations.length || result.incomplete.length))
        window.a11yQueueFixture.errors.push("The held scan did not pass.");
    });
    channel.on("storybook/a11y/error", (error: Error) => window.a11yQueueFixture.errors.push(error.message));
    channel.emit("storybook/a11y/manual", "held-fixture", {
      context: "#axe-queue-pass",
      config: {
        checks: [
          {
            id: "openbot-held-check",
            evaluate: function (this: CheckHelper) {
              const done = this.async();
              window.a11yQueueFixture.release = () => done(true);
            },
          },
        ],
        rules: [{ id: "color-contrast", selector: "#axe-queue-pass", any: ["openbot-held-check"], enabled: true }],
      },
      options: { runOnly: { type: "rule", values: ["color-contrast"] } },
    });
  });
  await page.waitForFunction(() => window.a11yQueueFixture.release !== null);

  // The old direct run bypasses the addon's queue. Keep this reproduction in the report.
  report.directRunFailure = await page.evaluate<string>(
    `(async () => {
      try { await axe.run("#axe-queue-pass", ${JSON.stringify(contrast)}); return "Unexpected success"; }
      catch (error) { return error.message; }
    })()`,
  );
  assert.match(report.directRunFailure, /Axe is already running/);
  report.cases.push("Direct Axe run reproduces the CI error while the addon's real scan is held.");

  // Record when the next request reaches the real addon, which resets Axe before it queues work.
  await page.evaluate(`{
    const reset = axe.reset;
    axe.reset = (...args) => {
      const result = reset.apply(axe, args);
      window.a11yQueueFixture.resets += 1;
      return result;
    };
  }`);
  const queued = runStorybookA11y(page, "#axe-queue-pass", { runOnly: { type: "rule", values: ["color-contrast"] } });
  await page.waitForFunction(() => window.a11yQueueFixture.resets > 0);
  assert.deepEqual(await page.evaluate(() => window.a11yQueueFixture.completed), []);
  await page.evaluate(() => window.a11yQueueFixture.release?.());
  const passed = await queued;
  assert.deepEqual(passed.violations, []);
  assert.deepEqual(passed.incomplete, []);
  const completed = await page.evaluate(() => window.a11yQueueFixture.completed);
  assert.equal(completed[0], "held-fixture");
  assert.equal(completed.length, 2);
  assert.deepEqual(await page.evaluate(() => window.a11yQueueFixture.errors), []);
  report.cases.push("Queued scan waits for the held scan, then both finish without an Axe conflict.");

  const [readable, failed] = await Promise.all([
    runStorybookA11y(page, "#axe-queue-pass", { runOnly: { type: "rule", values: ["color-contrast"] } }),
    runStorybookA11y(page, "#axe-queue-fail", { runOnly: { type: "rule", values: ["color-contrast"] } }),
  ]);
  assert.deepEqual(readable.violations, []);
  assert.deepEqual(readable.incomplete, []);
  assert.ok(failed.violations.some((rule) => rule.id === "color-contrast"));
  writeFileSync(resolve(output, "contrast-violation.json"), `${JSON.stringify(failed, null, 2)}\n`);
  report.cases.push("Concurrent requests retain their own results; low contrast still produces a violation.");

  const listeners = await page.evaluate(() =>
    window.__STORYBOOK_ADDONS_CHANNEL__?.listenerCount("storybook/a11y/result"),
  );
  await assert.rejects(runStorybookA11y(page, "#missing-axe-fixture", {}), /No elements found/);
  assert.equal(
    await page.evaluate(() => window.__STORYBOOK_ADDONS_CHANNEL__?.listenerCount("storybook/a11y/result")),
    listeners,
  );
  report.cases.push("Actual Axe context errors reject the caller and remove result listeners.");
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
