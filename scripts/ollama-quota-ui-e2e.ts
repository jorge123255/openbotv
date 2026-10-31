// Drives shared quota UI and the real conversation adapter in isolated Storybook with mock accounts.
// bun scripts/ollama-quota-ui-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { runStorybookA11y } from "./storybook-a11y";

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/ollama-quota-ui-e2e");
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  screenshots: string[];
  externalRequests: string[];
  contrast: { theme: string; surface: string; violations: string[]; incomplete: string[] }[];
  failure?: string;
} = {
  passed: false,
  cases: [],
  pageErrors: [],
  screenshots: [],
  externalRequests: [],
  contrast: [],
};
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
async function story(id: string, width = 1100, theme = "dark") {
  await page.setViewportSize({ width, height: 1000 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", id);
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", `colorScheme:${theme}`);
  await page.goto(url.href);
  await page.getByRole("region", { name: "Ollama Cloud usage", exact: true }).waitFor({ timeout: 60_000 });
}
async function screenshot(name: string) {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  report.screenshots.push(path);
}
async function contrast(theme: string, surface: string, selector: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
  const details = await runStorybookA11y(page, selector, { runOnly: { type: "rule", values: ["color-contrast"] } });
  const result = {
    violations: details.violations.map((value) => value.id),
    incomplete: details.incomplete.map((value) => value.id),
  };
  report.contrast.push({ theme, surface, ...result });
  if (result.violations.length || result.incomplete.length) {
    writeFileSync(resolve(output, `contrast-${theme}-${surface}.json`), JSON.stringify(details, null, 2));
  }
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.incomplete, []);
}
try {
  for (const theme of ["dark", "light"])
    for (const width of [1100, 390]) {
      await story("conversation-account-quota--warning", width, theme);
      await page.getByRole("alert").waitFor();
      await page.getByText("Ollama Cloud · Personal cloud", { exact: true }).click();
      await page.getByText("Included allowance: 95% used", { exact: false }).waitFor();
      await page.getByText("Purchased credits: $25.00. Separate", { exact: false }).waitFor();
      await screenshot(`warning-${theme}-${width}`);
      if (width === 390) {
        await contrast(theme, "notice", ".quota-notice");
      }
      await page.getByRole("button", { name: "Review switch", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByText("Its remaining quota and cost are unknown.", { exact: false }).waitFor();
      await screenshot(`confirmation-${theme}-${width}`);
      if (width === 390) await contrast(theme, "confirmation", "[role=alertdialog]");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await page.getByLabel("Next turn model", { exact: true }).textContent(), "Ollama Cloud");
      await page.getByRole("button", { name: "Review switch", exact: true }).click();
      await page.getByRole("button", { name: "Switch next turn", exact: true }).click();
      await page.getByLabel("Next turn model", { exact: true }).filter({ hasText: "Mock Claude" }).waitFor();
      await page.getByRole("button", { name: "Dismiss usage warning", exact: true }).click();
      assert.equal(await page.getByRole("alert").count(), 0);
      report.cases.push(`${theme}/${width}: separate balances, cancel, explicit switch, dismiss`);
    }
  for (const id of ["below-threshold", "stale", "unknown", "unavailable", "expired"]) {
    await story(`conversation-account-quota--${id}`);
    await page.getByText("Ollama Cloud · Personal cloud", { exact: true }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Review switch", exact: true }).count(), 0);
    await screenshot(id);
    report.cases.push(`${id}: no warning or switch prompt`);
  }
  await story("conversation-account-quota--legacy-windows");
  await page.getByText("Ollama Cloud · Personal cloud", { exact: true }).click();
  await page.getByText("Session allowance: 92% used", { exact: false }).waitFor();
  await page.getByText("Weekly allowance: 40% used", { exact: false }).waitFor();
  await screenshot("legacy-windows");
  report.cases.push("Legacy session and weekly windows retain separate percentages and resets");
  await story("conversation-ollama-quota-integration--active-turn");
  await page.getByRole("button", { name: "Review switch", exact: true }).waitFor();
  const editor = page.getByRole("textbox").filter({ visible: true }).first();
  await editor.fill("Keep this unsent draft.");
  const actions = page.getByLabel("Fixture actions", { exact: true });
  assert.match(await actions.innerText(), /Model changes: 0; messages sent: 0; stops: 0/);
  await page.getByRole("button", { name: "Review switch", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.match(await actions.innerText(), /Model changes: 0; messages sent: 0; stops: 0/);
  await page.getByRole("button", { name: "Review switch", exact: true }).click();
  await page.getByRole("button", { name: "Switch next turn", exact: true }).click();
  await actions.filter({ hasText: "Model changes: 1; messages sent: 0; stops: 0" }).waitFor();
  await page.getByText("After this turn", { exact: false }).first().waitFor();
  assert.equal(await editor.innerText(), "Keep this unsent draft.");
  await screenshot("active-turn-confirmed");
  report.cases.push(
    "Real conversation adapter: confirmation only; one queued model change; no send/stop; draft preserved",
  );
  await story("conversation-ollama-quota-integration--account-changes-during-confirmation");
  await page.getByRole("button", { name: "Review switch", exact: true }).click();
  await page.getByRole("button", { name: "Switch next turn", exact: true }).click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  assert.match(
    await page.getByLabel("Fixture actions", { exact: true }).innerText(),
    /Model changes: 0; messages sent: 0; stops: 0/,
  );
  await page.getByRole("button", { name: "Review switch", exact: true }).click();
  await page.getByText("changed-account@example.com", { exact: false }).waitFor();
  await screenshot("account-changed-requires-confirmation");
  report.cases.push("Target account changed during quota check: old confirmation cancelled; no switch or send");
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, [], "Fixtures must make no external HTTP requests.");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await screenshot("failure");
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
