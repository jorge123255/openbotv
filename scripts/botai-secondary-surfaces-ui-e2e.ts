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
const report: {
  passed: boolean;
  cases: string[];
  screenshots: string[];
  pageErrors: string[];
  step?: string;
  failure?: string;
} = {
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
async function open(id: string, selector: string, width = 1280, theme: "dark" | "light" = "dark") {
  report.step = `${id}: ${theme}, ${width}px`;
  await page.setViewportSize({ width, height: 800 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", id);
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("globals", `colorScheme:${theme}`);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.locator(selector).first().waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction((value) => document.documentElement.dataset.openbotColorScheme === value, theme);
}
async function shot(name: string) {
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
}
async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const result = await control.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      name: element.getAttribute("aria-label") ?? element.textContent,
      bounds: r.toJSON(),
      hit: hit?.outerHTML.slice(0, 240),
      reachable: r.width > 0 && r.height > 0 && hit !== null && (hit === element || element.contains(hit)),
    };
  });
  assert.equal(result.reachable, true, `Control center must receive pointer events: ${JSON.stringify(result)}`);
  await control.focus();
  assert.equal(await control.evaluate((element) => element === document.activeElement), true, `${result.name}: focus`);
}

// Check the whole control after scrolling, including both the dock scrollport and the canvas.
async function fullyFits(control: Locator) {
  const result = await control.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const clips = [
      element.closest<HTMLElement>(".wfn-hud"),
      element.closest<HTMLElement>(".wfn-search-results"),
      element.closest<HTMLElement>(".wfn-bottom-panels"),
      element.closest<HTMLElement>(".wfn-canvas"),
    ].flatMap((clip) => {
      if (!clip || getComputedStyle(clip).display === "contents") return [];
      const d = clip.getBoundingClientRect();
      const left = d.left + clip.clientLeft;
      const top = d.top + clip.clientTop;
      return [
        {
          name: clip.className,
          bounds: d.toJSON(),
          fits:
            r.left >= left - 1 &&
            r.right <= left + clip.clientWidth + 1 &&
            r.top >= top - 1 &&
            r.bottom <= top + clip.clientHeight + 1,
        },
      ];
    });
    return {
      name: element.getAttribute("aria-label") ?? element.textContent,
      bounds: r.toJSON(),
      clips,
      fits:
        r.left >= -1 &&
        r.top >= -1 &&
        r.right <= innerWidth + 1 &&
        r.bottom <= innerHeight + 1 &&
        clips.every((clip) => clip.fits),
    };
  });
  assert.equal(result.fits, true, `Control must fit fully inside its scrollports: ${JSON.stringify(result)}`);
}

async function separateHuds() {
  const bounds = await page.locator(".wfn-bottom-controls > .wfn-hud, .wfn-bottom-panels").evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
      .map((element) => {
        const r = element.getBoundingClientRect();
        return { name: element.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
  );
  const canvas = await page.locator(".wfn-canvas").boundingBox();
  assert.ok(canvas);
  for (const box of bounds) {
    assert.ok(
      box.left >= canvas.x - 1 &&
        box.right <= canvas.x + canvas.width + 1 &&
        box.top >= canvas.y - 1 &&
        box.bottom <= canvas.y + canvas.height + 1,
      `HUD must fit in canvas: ${JSON.stringify(box)}`,
    );
    for (const other of bounds) {
      if (box === other) continue;
      assert.ok(
        box.right <= other.left + 1 ||
          other.right <= box.left + 1 ||
          box.bottom <= other.top + 1 ||
          other.bottom <= box.top + 1,
        `HUDs must not overlap: ${JSON.stringify([box, other])}`,
      );
    }
  }
}

async function workflowControls() {
  const dock = page.locator(".wfn-hud-tools");
  assert.equal(await dock.getByRole("button").count(), 8);
  for (const name of ["Select", "Pan", "Draw", "Sticky note", "Shapes", "Text", "Search", "Add node"]) {
    const control = dock.getByRole("button", { name, exact: true });
    assert.equal(await control.isEnabled(), true, `${name} must stay enabled.`);
    await reachable(control);
    await fullyFits(control);
  }
  const zoom = page.locator(".wfn-hud-zoom");
  assert.equal(await zoom.getByRole("button").count(), 5);
  for (const control of await zoom.getByRole("button").all()) {
    if (await control.isDisabled()) {
      // Disabled zoom limits do not take pointer events or keyboard focus by design.
      const name = await control.getAttribute("aria-label");
      assert.ok(name === "Zoom out" || name === "Zoom in");
      assert.equal(
        await zoom.getByRole("button", { name: /^Zoom \d+%$/ }).getAttribute("aria-label"),
        name === "Zoom out" ? "Zoom 25%" : "Zoom 200%",
      );
      await control.scrollIntoViewIfNeeded();
    } else await reachable(control);
    await fullyFits(control);
  }
  await separateHuds();
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
  for (const theme of ["dark", "light"] as const) {
    for (const width of [390, 1024, 1280]) {
      await open("workflows--example", ".wfn-hud-tools", width, theme);
      await workflowControls();
      const tools = page.locator(".wfn-hud-tools");
      await tools.getByRole("button", { name: "Search", exact: true }).click();
      const search = page.getByRole("search", { name: "Search the canvas", exact: true });
      await search.getByRole("textbox").fill("e");
      await page.waitForFunction(() => document.querySelectorAll(".wfn-search-result").length === 8);
      // This also protects the previous desktop paint order after grouping the panels.
      await reachable(search.locator(".wfn-search-result").last());
      await fullyFits(search.locator(".wfn-search-result").last());
      await page.keyboard.press("Escape");
      await search.waitFor({ state: "hidden" });
      await shot(`workflow-controls-${theme}-${width}`);
      report.cases.push(
        `${theme} workflow at ${width}px: all eight tool centers, zoom, keyboard focus, full fit and last search result remain reachable.`,
      );
    }

    await open("workflows--narrow-canvas", ".wfn-hud-tools", 1280, theme);
    const narrow = await page.locator(".wfn-canvas").boundingBox();
    assert.ok(narrow && Math.abs(narrow.width - 390) < 1);
    await workflowControls();
    await shot(`workflow-narrow-pane-${theme}`);
    report.cases.push(`${theme} 390px canvas inside a 1280px window follows its own width.`);

    await open("workflows--example", ".wfn-hud-tools", 390, theme);
    const tools = page.locator(".wfn-hud-tools");
    const zoom = page.locator(".wfn-hud-zoom");
    await zoom.getByRole("button", { name: /^Zoom \d+%$/ }).click();
    await page.getByRole("menuitem", { name: "50%", exact: true }).click();
    await zoom.getByRole("button", { name: "Zoom 50%", exact: true }).waitFor();
    await zoom.getByRole("button", { name: "Zoom in", exact: true }).click();
    await zoom.getByRole("button", { name: "Zoom 60%", exact: true }).waitFor();
    await zoom.getByRole("button", { name: "Zoom out", exact: true }).click();
    await zoom.getByRole("button", { name: "Zoom 50%", exact: true }).waitFor();
    await tools.getByRole("button", { name: "Pan", exact: true }).click();
    assert.equal(await page.locator(".wfn-canvas").getAttribute("data-tool"), "pan");
    await tools.getByRole("button", { name: "Select", exact: true }).click();
    assert.equal(await page.locator(".wfn-canvas").getAttribute("data-tool"), "select");
    for (const name of ["Draw", "Sticky note", "Shapes"]) {
      await tools.getByRole("button", { name, exact: true }).click();
      const palette = page.getByRole("toolbar", { name, exact: true });
      await palette.waitFor();
      for (const control of await palette.getByRole("button").all()) {
        await reachable(control);
        await fullyFits(control);
      }
      await separateHuds();
      await tools.getByRole("button", { name: "Select", exact: true }).click();
      await palette.waitFor({ state: "hidden" });
    }
    await tools.getByRole("button", { name: "Add node", exact: true }).click();
    const addMenu = page.getByRole("menu", { name: "Add node", exact: true });
    await addMenu.waitFor();
    await reachable(addMenu.getByRole("menuitem").first());
    await page.keyboard.press("Escape");
    await addMenu.waitFor({ state: "hidden" });

    // The tallest combination must scroll optional panels without covering the fixed controls.
    await page.setViewportSize({ width: 390, height: 600 });
    await page.getByRole("button", { name: "Open minimap", exact: true }).click();
    await tools.getByRole("button", { name: "Draw", exact: true }).click();
    await tools.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByRole("search", { name: "Search the canvas", exact: true });
    await search.getByRole("textbox").fill("e");
    await page.waitForFunction(() => document.querySelectorAll(".wfn-search-result").length === 8);
    await separateHuds();
    const panels = page.locator(".wfn-bottom-panels");
    assert.equal(await panels.evaluate((element) => element.scrollHeight > element.clientHeight), true);
    for (const control of await panels.getByRole("button").all()) {
      await reachable(control);
      await fullyFits(control);
    }
    await workflowControls();
    await shot(`workflow-panels-${theme}-390x600`);
    // Hide retains the open panels, but their scroll wrapper must stop intercepting canvas hits.
    const panelBox = await panels.boundingBox();
    assert.ok(panelBox);
    const hidePoint = { x: panelBox.x + panelBox.width / 2, y: panelBox.y + panelBox.height / 2 };
    await tools.getByRole("button", { name: "Select", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+/");
    await page.getByRole("button", { name: "Show interface", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest(".wfn-bottom-controls") === null,
        hidePoint,
      ),
      true,
    );
    await page.getByRole("button", { name: "Show interface", exact: true }).click();
    await search.waitFor();
    await search.getByRole("textbox").press("Escape");
    await search.waitFor({ state: "hidden" });
    await tools.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: "Close minimap", exact: true }).click();
    await page.locator(".wfn-minimap").waitFor({ state: "hidden" });
    await workflowControls();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator(".wfn-hud-switcher").click();
    await page.getByRole("menuitem", { name: "Version history", exact: true }).press("ArrowRight");
    const versions = page.getByRole("menu", { name: "Version history", exact: true });
    await versions.waitFor();
    assert.equal(await versions.getByRole("menuitem").count(), 4);
    await versions.getByRole("menuitem").nth(1).click();
    const preview = page.getByRole("region", { name: "Version preview", exact: true });
    await preview.waitFor();
    for (const control of await preview.getByRole("button").all()) {
      await reachable(control);
      await fullyFits(control);
    }
    await separateHuds();
    await shot(`workflow-version-${theme}-390`);
    await preview.getByRole("button", { name: "Back", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    await workflowControls();
    report.cases.push(
      `${theme} narrow zoom presets/in/out, palettes, Add node menu, combined search/minimap/draw and version preview remain reachable; hide/show releases canvas hits and reverses without adding nodes or restoring a version.`,
    );
  }
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
