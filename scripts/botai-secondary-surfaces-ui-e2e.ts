// Offline real workflow workspace, island and dock controls. Run only in the isolated VM or CI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage:
    "bun scripts/botai-secondary-surfaces-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chromium";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/botai-secondary-surfaces-ui-e2e");
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
async function open(id: string, selector: string, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", id);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.locator(selector).first().waitFor();
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
      return r.width > 0 && r.height > 0 && hit !== null && (hit === element || element.contains(hit));
    }),
    true,
  );
  await control.focus();
  assert.equal(await control.evaluate((element) => element === document.activeElement), true);
}
try {
  await open("workflows--in-app", ".roster-row");
  const rail = page.locator(".window-rail");
  const editor = page.locator('.composer-editor-surface[contenteditable="true"]').first();
  await editor.fill("Keep the workflow review draft.");
  const chat = await page.locator(".conversation-title h1").innerText();
  await rail.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Workflows", exact: true }).click();
  await page.locator(".wfn-canvas[data-frame=window]").waitFor();
  await page.locator(".wfn-hud-switcher").click();
  await page.getByRole("menuitem", { name: /^New competitor alert/ }).click();
  await page.waitForFunction(
    () => document.querySelector(".wfn-hud-switcher-name")?.textContent === "New competitor alert",
  );
  const before = await page.evaluate(() => window.openbot.workflows.get("new-competitor-alert"));
  await page.locator(".wfn-hud-switcher").click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Workflow name", exact: true }).fill("Cancelled offline rename");
  await page.keyboard.press("Escape");
  assert.equal(
    (await page.evaluate(() => window.openbot.workflows.get("new-competitor-alert"))).summary.title,
    before.summary.title,
  );
  await page.locator(".wfn-hud-tools").getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("search", { name: "Search the canvas", exact: true }).getByRole("textbox").fill("competitor");
  await page.keyboard.press("Escape");
  await page.locator(".wfn-search").waitFor({ state: "hidden" });
  for (const width of [1672, 1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await reachable(page.getByRole("button", { name: "Run workflow", exact: true }));
    await reachable(page.locator(".wfn-hud-switcher"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(`workflows-${width}`);
  }
  assert.deepEqual(
    (await page.evaluate(() => window.openbot.workflows.get("new-competitor-alert"))).graph,
    before.graph,
  );
  await rail.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".roster-row").first().waitFor();
  assert.equal(await editor.innerText(), "Keep the workflow review draft.");
  assert.equal(await page.locator(".conversation-title h1").innerText(), chat);
  report.cases.push(
    "Real App opens Workflows and returns to the same chat/draft; rename cancel/search preserve the graph; controls remain reachable at three desktop sizes.",
  );
  await open("workflows--example", ".wfn-hud-tools", 390);
  for (const control of await page.locator(".wfn-hud-tools button").all()) {
    await reachable(control);
    assert.equal(
      await control.evaluate((element) => {
        const dock = element.closest<HTMLElement>(".wfn-hud-tools");
        if (!dock) return false;
        const r = element.getBoundingClientRect();
        const d = dock.getBoundingClientRect();
        const left = d.left + dock.clientLeft;
        const top = d.top + dock.clientTop;
        return (
          r.left >= left - 1 &&
          r.right <= left + dock.clientWidth + 1 &&
          r.top >= top - 1 &&
          r.bottom <= top + dock.clientHeight + 1
        );
      }),
      true,
      "Every tool must fit fully inside the dock scrollport.",
    );
  }
  await shot("workflow-tools-390");
  const lightUrl = new URL("/iframe.html?id=workflows--example&viewMode=story&globals=colorScheme:light", target);
  await page.goto(lightUrl.href);
  await page.locator(".wfn-hud-tools").waitFor();
  await shot("workflow-light-390");
  report.cases.push("The narrow workflow tool dock keeps every control reachable by pointer and keyboard.");
  await open("conversation-browserdock--interactive-bot-ai", ".browser-dock", 688);
  const dockEditor = page.locator('.browser-dock .composer-editor-surface[contenteditable="true"]');
  await dockEditor.fill("Offline BotAI dock message");
  const send = page.locator(".browser-dock").getByRole("button", { name: "Send message", exact: true });
  await reachable(send);
  await send.click();
  await page
    .getByLabel("Sent fixture message", { exact: true })
    .filter({ hasText: "Offline BotAI dock message" })
    .waitFor();
  assert.equal(await dockEditor.innerText(), "");
  assert.match(
    await page
      .locator(".browser-dock-glass")
      .first()
      .evaluate((element) => getComputedStyle(element).backdropFilter),
    /blur\(/,
  );
  await shot("dock-send-688");
  report.cases.push(
    "The real dock edits and submits through synthetic callbacks, clears its draft and retains an explicitly measurable blur.",
  );
  for (const story of ["agent-acting", "user-control", "secret-request", "reply"]) {
    await open(`conversation-browserdock--${story}`, ".browser-dock", 688);
    const box = await page.locator(".browser-dock").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 688);
    await shot(`dock-${story}`);
  }
  await open("window-dynamic-island--bot-ai-idle", ".dynamic-island");
  assert.equal(await page.locator('.dynamic-island .app-logo[data-artwork="botai"]').count(), 2);
  await shot("island-idle-both-displays");
  await open("window-dynamic-island--failed-reply", ".dynamic-island-reply-input");
  for (const island of await page.locator(".dynamic-island").all()) {
    const reply = island.locator(".dynamic-island-reply-input");
    await reply.fill("Retain this failed fixture reply");
    await island.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal(await reply.inputValue(), "Retain this failed fixture reply");
    assert.equal(await island.getAttribute("data-state"), "expanded");
    await reply.press("Escape");
    assert.equal(await island.getAttribute("data-state"), "compact");
    const toggle = island.locator(".dynamic-island-toggle");
    await page.waitForFunction((element) => element === document.activeElement, await toggle.elementHandle());
  }
  await shot("island-failed-reply-retained");
  report.cases.push(
    "Both island display modes retain a failed reply, keep the panel open, and restore toggle focus on Escape.",
  );
  await open("window-dynamic-island--bot-ai-characters", ".dynamic-island");
  await shot("island-characters");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open("conversation-browserdock--interactive-bot-ai", ".browser-dock", 688);
  const movingEditor = page.locator('.browser-dock .composer-editor-surface[contenteditable="true"]');
  await movingEditor.fill("Normal motion fixture message");
  await page.locator(".browser-dock").getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByLabel("Sent fixture message", { exact: true })
    .filter({ hasText: "Normal motion fixture message" })
    .waitFor();
  await open("window-dynamic-island--bot-ai-characters", ".dynamic-island");
  for (const island of await page.locator(".dynamic-island").all()) {
    const box = await island.boundingBox();
    assert.ok(box && box.width <= 614 && box.height <= 380);
    await island.locator(".dynamic-island-toggle").press("Escape");
    assert.equal(await island.getAttribute("data-state"), "compact");
    await page.waitForFunction(
      (element) => element === document.activeElement,
      await island.locator(".dynamic-island-toggle").elementHandle(),
    );
  }
  await shot("island-characters-normal-motion");
  report.cases.push(
    "Normal-motion dock submission and island Escape remain usable; browser fixture bounds fit the native host limit, without claiming native rendering parity.",
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
