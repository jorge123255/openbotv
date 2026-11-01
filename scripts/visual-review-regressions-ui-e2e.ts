// Exact response-order and first-activation cases from the isolated visual review.
// Run only against offline Storybook fixtures in the verified VM or CI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage:
    "bun scripts/visual-review-regressions-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chromium";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/visual-review-regressions-ui-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; failure?: string } = {
  passed: false,
  cases: [],
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
try {
  await open("app--avatar-save-race", ".roster-row");
  const before = await page.evaluate(() => window.openbot.agent.listAgents("local"));
  await page.locator('.roster-row-active [data-character="wisp"]').waitFor();
  await page.locator(".conversation-title").click();
  await page.getByRole("button", { name: "Edit agent avatar", exact: true }).click();
  await page.getByRole("button", { name: "Pebble", exact: true }).click();
  await page.getByLabel("Avatar response fixture", { exact: true }).filter({ hasText: "pending" }).waitFor();
  await page.getByRole("button", { name: "Sprout", exact: true }).click();
  await page.locator('.roster-row-active [data-character="sprout"]').waitFor();
  const newer = (await page.evaluate(() => window.openbot.agent.listAgents("local"))).find(
    (agent) => agent.id === "chief",
  );
  assert.equal(newer?.avatarCharacter, "sprout");
  // This control advances a synthetic network response, without a pointerdown outside the studio.
  await page.getByRole("button", { name: "Reject older avatar save", exact: true }).dispatchEvent("click");
  await page.getByLabel("Avatar response fixture", { exact: true }).filter({ hasText: "released" }).waitFor();
  // A rendered-frame event lets the rejected promise chain and its reactive DOM updates settle.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(await page.getByRole("button", { name: "Sprout", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "Wisp", exact: true }).getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator(".agent-settings-save-error").count(), 0);
  await page.locator('.roster-row-active [data-character="sprout"]').waitFor();
  await page.locator('.companion-stage [data-character="sprout"]').waitFor();
  const after = await page.evaluate(() => window.openbot.agent.listAgents("local"));
  assert.equal(after.length, before.length);
  for (const prior of before) {
    const next = after.find((agent) => agent.id === prior.id);
    assert.ok(next);
    for (const key of ["id", "avatarSeed", "avatarHue", "avatarUrl", "threadId", "workspacePath"] as const)
      assert.equal(next[key], prior[key]);
    assert.equal(next.avatarCharacter, prior.id === "chief" ? "sprout" : prior.avatarCharacter);
  }
  await page.screenshot({ path: resolve(output, "avatar-newer-save-retained.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await page.locator(".conversation-title").click();
  await page.getByRole("button", { name: "Edit agent avatar", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Sprout", exact: true }).getAttribute("aria-pressed"), "true");
  report.cases.push(
    "Wisp→older Pebble pending→newer Sprout saved→older rejection keeps Sprout in editor/roster/stage and after reopening, without stale error or identity/seed/image changes.",
  );
  await open("app--avatar-upload-race", ".roster-row-active .agent-avatar-custom img");
  const uploadBefore = (await page.evaluate(() => window.openbot.agent.listAgents("local"))).find(
    (agent) => agent.id === "chief",
  );
  await page.locator(".conversation-title").click();
  await page.getByRole("button", { name: "Edit agent avatar", exact: true }).click();
  await page.getByRole("button", { name: "Pebble", exact: true }).click();
  await page.getByLabel("Avatar response fixture", { exact: true }).filter({ hasText: "pending" }).waitFor();
  await page
    .locator(".avatar-editor")
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await page.waitForFunction(
    async () =>
      (await window.openbot.agent.listAgents("local"))
        .find((agent) => agent.id === "chief")
        ?.avatarUrl?.startsWith("data:image/webp;") === true,
  );
  const replacement = (await page.evaluate(() => window.openbot.agent.listAgents("local"))).find(
    (agent) => agent.id === "chief",
  )?.avatarUrl;
  assert.ok(replacement && replacement !== uploadBefore?.avatarUrl);
  await page.getByRole("button", { name: "Complete older avatar save", exact: true }).dispatchEvent("click");
  await page.waitForFunction(
    async () =>
      (await window.openbot.agent.listAgents("local")).find((agent) => agent.id === "chief")?.avatarCharacter ===
      "pebble",
  );
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const uploaded = (await page.evaluate(() => window.openbot.agent.listAgents("local"))).find(
    (agent) => agent.id === "chief",
  );
  assert.equal(uploaded?.avatarUrl, replacement);
  assert.equal(uploaded?.avatarSeed, uploadBefore?.avatarSeed);
  assert.equal(await page.locator(".roster-row-active .agent-avatar-custom img").getAttribute("src"), replacement);
  assert.equal(await page.locator(".companion-stage").count(), 0);
  await page.screenshot({ path: resolve(output, "avatar-new-photo-retained.png") });
  report.cases.push(
    "A replacement photo normalized/uploaded through the real input remains after an older character save succeeds; its literal seed is unchanged.",
  );
  for (const width of [1280, 1120, 1024, 390]) {
    await open("agents-usage--usage", ".agent-usage-total-panel", width);
    await page.getByRole("table", { name: "Usage by agent", exact: true }).waitFor();
    assert.equal(await page.locator(".agent-usage-totals > div:visible").count(), 8);
    const errors = await page.locator(".agent-usage-totals dt").evaluateAll((labels) =>
      labels.flatMap((label) => {
        const tile = label.parentElement?.getBoundingClientRect();
        if (!tile) return ["Missing metric tile"];
        const range = document.createRange();
        range.selectNodeContents(label);
        const outside = [...range.getClientRects()].some(
          (r) =>
            r.left < tile.left - 1 || r.right > tile.right + 1 || r.top < tile.top - 1 || r.bottom > tile.bottom + 1,
        );
        return outside || label.scrollWidth > label.clientWidth + 1 ? [label.textContent ?? "Unknown label"] : [];
      }),
    );
    assert.deepEqual(errors, [], `Metric labels must remain readable inside tiles at${width}px.`);
    await page.getByRole("button", { name: "View daily data", exact: true }).click();
    const table = page.getByRole("table", { name: "Daily usage and cost", exact: true });
    await table.waitFor();
    await page.waitForFunction((element) => element === document.activeElement, await table.elementHandle(), {
      timeout: 5_000,
    });
    assert.equal(await table.evaluate((element) => element.closest("[inert]") === null), true);
    await page.screenshot({ path: resolve(output, `usage-first-activation-${width}.png`) });
    report.cases.push(
      `${width}px: all eight labels fit their tiles and the first View daily data click focuses the selected table.`,
    );
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
