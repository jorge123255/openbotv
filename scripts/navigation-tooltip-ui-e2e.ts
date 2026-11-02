// Real top navigation with a visible tooltip. Run only in the isolated review VM or CI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/navigation-tooltip-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chromium";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/navigation-tooltip-ui-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; step?: string; failure?: string } = {
  passed: false,
  cases: [],
  pageErrors: [],
};
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
async function open(story: string, ready: string) {
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", story);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.locator(ready).first().waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await page.evaluate(() => document.fonts.ready);
}
async function hit(control: Locator) {
  assert.equal(
    await control.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 4, r.top + r.height / 2],
        [r.right - 4, r.top + r.height / 2],
      ].every(([x, y]) => {
        if (x === undefined || y === undefined) return false;
        const found = document.elementFromPoint(x, y);
        return found !== null && (found === element || element.contains(found));
      });
    }),
    true,
    "A visible label tooltip must not intercept the adjacent control.",
  );
}
async function pointerClick(control: Locator) {
  const box = await control.boundingBox();
  assert.ok(box);
  // Raw pointer input does not wait for an overlay to disappear or force a click through it.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}
try {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion });
    await open("workflows--in-app", ".roster-row");
    const rail = page.locator(".window-rail");
    await rail.getByRole("button", { name: "More", exact: true }).click();
    const pin = page.getByRole("menuitemcheckbox", { name: "Pin Workflows to the rail", exact: true });
    if ((await pin.getAttribute("aria-checked")) !== "true") await pin.click();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    const agents = rail.getByRole("button", { name: "Agents", exact: true });
    const workflows = rail.getByRole("button", { name: "Workflows", exact: true });
    const editor = page.locator('.composer-editor-surface[contenteditable="true"]').first();
    await editor.fill("Keep the tooltip regression draft.");
    report.step = `${reducedMotion}: Agents label before the first raw Workflows click`;
    await agents.hover();
    const label = page.getByRole("tooltip", { name: "Agents", exact: true });
    await label.waitFor();
    const labelBox = await label.boundingBox();
    const agentsBox = await agents.boundingBox();
    assert.ok(labelBox && agentsBox && labelBox.y >= agentsBox.y + agentsBox.height);
    assert.equal(await label.evaluate((element) => getComputedStyle(element).pointerEvents), "none");
    await hit(workflows);
    await page.screenshot({ path: resolve(output, `agents-hover-${reducedMotion}-1024.png`) });
    await pointerClick(workflows);
    await page.locator('.wfn-canvas[data-frame="window"]').waitFor();
    assert.equal(await workflows.getAttribute("aria-current"), "page");
    report.cases.push(
      `${reducedMotion}: at1024px, a visible Agents label does not block the first raw Workflows click.`,
    );
    // Click dismisses a tooltip. Re-enter from a different trigger to test a real handoff within the rail.
    report.step = `${reducedMotion}: re-enter Agents within the rail`;
    await agents.hover();
    await label.waitFor();
    report.step = `${reducedMotion}: enter Workflows from Agents`;
    await workflows.hover();
    const workflowLabel = page.getByRole("tooltip", { name: "Workflows", exact: true });
    await workflowLabel.waitFor();
    assert.equal(await workflowLabel.evaluate((element) => getComputedStyle(element).pointerEvents), "none");
    await hit(agents);
    await page.screenshot({ path: resolve(output, `workflows-hover-${reducedMotion}-1024.png`) });
    report.step = `${reducedMotion}: raw Agents return click and retained draft`;
    await pointerClick(agents);
    await page.locator(".roster-row").first().waitFor();
    assert.equal(await agents.getAttribute("aria-current"), "page");
    assert.equal(await editor.innerText(), "Keep the tooltip regression draft.");
    report.cases.push(
      `${reducedMotion}: a fresh Workflows label handoff does not block the raw Agents return click; the draft stays intact.`,
    );
  }
  await open("window-pagerail--shared-quota", ".window-rail");
  report.step = "Interactive account usage card";
  await page.locator(".window-rail-accounts button").first().hover();
  const card = page.locator(".window-rail-usage-card");
  await card.waitFor();
  assert.equal(
    await card.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return getComputedStyle(element).pointerEvents !== "none" && found !== null && element.contains(found);
    }),
    true,
    "Usage cards retain pointer input; only plain labels are transparent.",
  );
  report.cases.push("Interactive account usage cards remain pointer-reachable.");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {
    // Preserve the test failure if the browser has already closed.
  });
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
