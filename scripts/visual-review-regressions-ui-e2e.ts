// Exact response-order and first-activation cases from the isolated visual review.
// Run only against offline Storybook fixtures in the verified VM or CI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage:
    "bun scripts/visual-review-regressions-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium] [--trace-focus]",
  options: {
    url: { type: "string" },
    "browser-channel": { type: "string" },
    "trace-focus": { type: "boolean" },
  },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chromium";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(
  import.meta.dirname,
  `../.openbot-build/visual-review-regressions-ui-e2e${args.values["trace-focus"] ? "-focus-trace" : ""}`,
);
mkdirSync(output, { recursive: true });
type FocusSample = {
  event: string;
  time: number;
  active: string;
  selected: boolean;
  blocked: boolean;
  connected: boolean;
  tabIndex: number | null;
  observerReady: boolean;
  stack?: string;
  frame?: number;
};
declare global {
  interface Window {
    __usageFocusTrace?: { start: () => void; read: () => FocusSample[] };
    __usageFocusAttempts?: number;
  }
}
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  focusDiagnostics: { case: string; passed: boolean; capReached: boolean; samples: FocusSample[] }[];
  step?: string;
  failure?: string;
} = {
  passed: false,
  cases: [],
  pageErrors: [],
  focusDiagnostics: [],
};
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
// Synthetic fixture diagnostics only. Do not read layout in a frame callback: a style flush
// could change the failure under investigation. The trace stays bounded and records no chat text.
if (args.values["trace-focus"])
  await page.addInitScript(() => {
    let enabled = false;
    const samples: FocusSample[] = [];
    const observed = new WeakMap<Node, Set<MutationObserver>>();
    function record(event: string, stack?: string, frame?: number): void {
      if (!enabled || samples.length >= 256) return;
      const table = document.querySelector<HTMLTableElement>(".agent-usage-breakdown table[tabindex]");
      const panel = table?.closest('[role="tabpanel"]');
      const active = document.activeElement;
      samples.push({
        event,
        time: performance.now(),
        active: active === table ? "daily-table" : (active?.getAttribute("role") ?? active?.tagName ?? "none"),
        selected: panel?.hasAttribute("data-selected") ?? false,
        blocked: !!table?.closest("[inert], [hidden], [aria-hidden=true]"),
        connected: table?.isConnected ?? false,
        tabIndex: table?.tabIndex ?? null,
        observerReady: !!panel && !!observed.get(panel)?.size,
        stack,
        frame,
      });
    }
    const NativeObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeObserver {
      private targets = new Set<Node>();
      override observe(target: Node, options?: MutationObserverInit): void {
        if (options?.attributeFilter?.includes("inert")) {
          const observers = observed.get(target) ?? new Set<MutationObserver>();
          observers.add(this);
          observed.set(target, observers);
          this.targets.add(target);
          record("observer-installed");
        }
        super.observe(target, options);
      }
      override disconnect(): void {
        for (const target of this.targets) observed.get(target)?.delete(this);
        this.targets.clear();
        super.disconnect();
      }
    };
    const schedule = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const stack = enabled ? new Error().stack : undefined;
      const frame = schedule((time) => {
        record("frame-before", stack, frame);
        try {
          callback.call(window, time);
        } finally {
          record("frame-after", stack, frame);
        }
      });
      record("frame-scheduled", stack, frame);
      return frame;
    };
    window.cancelAnimationFrame = (frame) => {
      record("frame-canceled", undefined, frame);
      cancel(frame);
    };
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions): void {
      const daily = this.matches(".agent-usage-breakdown table[tabindex]");
      if (daily) record("daily-focus-before");
      try {
        focus.call(this, options);
      } finally {
        if (daily) record("daily-focus-after");
      }
    };
    document.addEventListener("focusin", () => record("focusin"), true);
    document.addEventListener("focusout", () => record("focusout"), true);
    window.__usageFocusTrace = {
      start() {
        samples.length = 0;
        enabled = true;
        record("start");
      },
      read() {
        record("end");
        enabled = false;
        return samples;
      },
    };
  });
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
async function open(story: string, ready: string, width = 1280) {
  report.step = story;
  await page.setViewportSize({ width, height: 800 });
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", story);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.locator(ready).first().waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await page.evaluate(() => document.fonts.ready);
}
async function openAvatarStudio() {
  const panel = page.getByRole("complementary", { name: "Agent settings", exact: true });
  await panel.waitFor();
  assert.equal(await panel.count(), 1);
  const edit = panel.getByRole("button", { name: "Edit agent avatar", exact: true });
  await edit.waitFor();
  assert.equal(await edit.count(), 1);
  assert.equal(await edit.getAttribute("aria-haspopup"), "dialog");
  assert.equal(await edit.getAttribute("aria-expanded"), "false");
  await edit.click();
  const studio = page.getByRole("dialog", { name: "Avatar studio", exact: true });
  await studio.waitFor();
  assert.equal(await studio.count(), 1);
  assert.equal(await edit.getAttribute("aria-expanded"), "true");
  const studioId = await studio.getAttribute("id");
  assert.ok(studioId);
  assert.equal(await edit.getAttribute("aria-controls"), studioId);
  return studio;
}
const focusFailures: string[] = [];
async function assertDailyFocus(caseName: string): Promise<void> {
  const table = page.getByRole("table", { name: "Daily usage and cost", exact: true });
  await table.waitFor();
  const reachedFocus = await page
    .waitForFunction((element) => element === document.activeElement, await table.elementHandle(), { timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  // Keep the trace through two frame boundaries to catch an immediate focus reversal.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const focused = reachedFocus && (await table.evaluate((element) => element === document.activeElement));
  const samples = await page.evaluate(() => window.__usageFocusTrace?.read() ?? []);
  report.focusDiagnostics.push({ case: caseName, passed: focused, capReached: samples.length >= 256, samples });
  if (await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    const panels = page.locator('.agent-usage-breakdown [role="tabpanel"]');
    const transitions = await panels.evaluateAll((elements) =>
      elements.map((element) => ({
        selected: element.hasAttribute("data-selected"),
        durations: getComputedStyle(element)
          .transitionDuration.split(",")
          .map((value) => Number.parseFloat(value)),
      })),
    );
    assert.ok(transitions.some((panel) => panel.selected));
    assert.ok(transitions.every((panel) => panel.durations.every((duration) => duration === 0)));
  }
  if (!focused) focusFailures.push(caseName);
  else report.cases.push(caseName);
}
async function refuseDailyFocus(calls: number): Promise<void> {
  // Fault injection at the browser focus boundary. Keep the real component and its scheduler.
  await page.evaluate((refusedCalls) => {
    window.__usageFocusAttempts = 0;
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions): void {
      if (this.matches(".agent-usage-breakdown table[tabindex]")) {
        const attempt = (window.__usageFocusAttempts ?? 0) + 1;
        window.__usageFocusAttempts = attempt;
        if (attempt <= refusedCalls) return;
      }
      focus.call(this, options);
    };
  }, calls);
}
async function holdAnimationFrames(): Promise<void> {
  await page.evaluate(() => {
    const schedule = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const held = new Map<number, FrameRequestCallback>();
    let next = 0;
    window.requestAnimationFrame = (callback) => {
      const id = --next;
      held.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (id < 0) held.delete(id);
      else cancel(id);
    };
    document.addEventListener(
      "fixture-release-animation-frames",
      () => {
        window.requestAnimationFrame = schedule;
        window.cancelAnimationFrame = cancel;
        for (const callback of held.values()) schedule(callback);
        held.clear();
      },
      { once: true },
    );
  });
}
async function releaseAnimationFrames(): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("fixture-release-animation-frames"));
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
try {
  await open("app--avatar-save-race", ".roster-row");
  const before = await page.evaluate(() => window.openbot.agent.listAgents("local"));
  await page.locator('.roster-row-active [data-character="wisp"]').waitFor();
  await page.locator(".conversation-title").click();
  const saveStudio = await openAvatarStudio();
  await saveStudio.getByRole("button", { name: "Pebble", exact: true }).click();
  await page.getByLabel("Avatar response fixture", { exact: true }).filter({ hasText: "pending" }).waitFor();
  await saveStudio.getByRole("button", { name: "Sprout", exact: true }).click();
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
  assert.equal(
    await saveStudio.getByRole("button", { name: "Sprout", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await saveStudio.getByRole("button", { name: "Wisp", exact: true }).getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(await page.locator(".agent-settings-save-error").count(), 0);
  assert.equal(
    await page
      .locator(".message-error-label")
      .filter({ hasText: /Could not (save agent settings|update the avatar)/ })
      .count(),
    0,
  );
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
  const reopenedStudio = await openAvatarStudio();
  assert.equal(
    await reopenedStudio.getByRole("button", { name: "Sprout", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  report.cases.push(
    "Wisp→older Pebble pending→newer Sprout saved→older rejection keeps Sprout in editor/roster/stage and after reopening, without stale panel/chat error or identity/seed/image changes.",
  );
  await open("app--avatar-upload-race", ".roster-row-active .agent-avatar-custom img");
  const uploadBefore = (await page.evaluate(() => window.openbot.agent.listAgents("local"))).find(
    (agent) => agent.id === "chief",
  );
  await page.locator(".conversation-title").click();
  const uploadStudio = await openAvatarStudio();
  await uploadStudio.getByRole("button", { name: "Pebble", exact: true }).click();
  await page.getByLabel("Avatar response fixture", { exact: true }).filter({ hasText: "pending" }).waitFor();
  await uploadStudio.getByLabel("Attach files", { exact: true }).setInputFiles({
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
  await open("app--character-save-failure", ".roster-row-active .agent-avatar-custom img");
  await page.locator(".conversation-title").click();
  const failureStudio = await openAvatarStudio();
  await failureStudio.getByRole("button", { name: "Pebble", exact: true }).click();
  await page.locator(".agent-settings-save-error").waitFor();
  await page.locator(".message-error-label").filter({ hasText: "Could not save agent settings" }).waitFor();
  report.cases.push(
    "A current avatar failure still reports both its panel error and chat status; only obsolete failures are suppressed.",
  );
  for (const motion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion: motion });
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
      await page.evaluate(() => window.__usageFocusTrace?.start());
      await page.getByRole("button", { name: "View daily data", exact: true }).click();
      await assertDailyFocus(`${motion}, ${width}px: first pointer activation focuses Daily.`);
      const table = page.getByRole("table", { name: "Daily usage and cost", exact: true });
      assert.equal(await table.evaluate((element) => element.closest("[inert]") === null), true);
      await page.screenshot({ path: resolve(output, `usage-first-activation-${motion}-${width}.png`) });
      report.cases.push(`${motion}, ${width}px: all eight labels fit their tiles.`);
    }
  }
  for (const motion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion: motion });
    await open("agents-usage--usage", ".agent-usage-total-panel");
    const firstKeyboardActivation = page.getByRole("button", { name: "View daily data", exact: true });
    await firstKeyboardActivation.focus();
    assert.equal(await firstKeyboardActivation.evaluate((element) => element === document.activeElement), true);
    await page.evaluate(() => window.__usageFocusTrace?.start());
    await firstKeyboardActivation.press("Enter");
    await assertDailyFocus(`${motion}: first keyboard activation focuses Daily.`);
  }
  for (const motion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion: motion });
    await open("agents-usage--usage", ".agent-usage-total-panel");
    await refuseDailyFocus(1);
    await page.evaluate(() => window.__usageFocusTrace?.start());
    await page.getByRole("button", { name: "View daily data", exact: true }).click();
    await assertDailyFocus(`${motion}: one rejected native focus retries on the next frame.`);
    assert.equal(await page.evaluate(() => window.__usageFocusAttempts), 2);
    await open("agents-usage--usage", ".agent-usage-total-panel");
    await refuseDailyFocus(4);
    const retryButton = page.getByRole("button", { name: "View daily data", exact: true });
    for (const attempts of [2, 4]) {
      await retryButton.click();
      await page.waitForFunction((expected) => window.__usageFocusAttempts === expected, attempts);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      assert.equal(await page.evaluate(() => window.__usageFocusAttempts), attempts);
      assert.equal(await retryButton.evaluate((element) => element === document.activeElement), true);
    }
    await page.evaluate(() => window.__usageFocusTrace?.start());
    await retryButton.click();
    await assertDailyFocus(`${motion}: each activation has a fresh two-attempt budget; the third succeeds.`);
    assert.equal(await page.evaluate(() => window.__usageFocusAttempts), 5);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open("agents-usage--usage", ".agent-usage-total-panel");
  await holdAnimationFrames();
  await page.getByRole("button", { name: "View daily data", exact: true }).click();
  await page.getByRole("table", { name: "Daily usage and cost", exact: true }).waitFor();
  const agentTab = page.getByRole("tab", { name: "Agent", exact: true });
  await agentTab.click();
  await page.getByRole("table", { name: "Usage by agent", exact: true }).waitFor();
  await agentTab.focus();
  assert.equal(await agentTab.evaluate((element) => element === document.activeElement), true);
  await releaseAnimationFrames();
  assert.equal(await agentTab.evaluate((element) => element === document.activeElement), true);
  report.cases.push("Switching tabs before the pending focus frame cancels the request and preserves tab focus.");
  await open("app--whole-app-workspace", ".roster-row");
  const rail = page.locator(".window-rail");
  await rail.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Usage", exact: true }).click();
  await page.locator(".agent-usage-total-panel").waitFor();
  await holdAnimationFrames();
  await page.getByRole("button", { name: "View daily data", exact: true }).click();
  await page.getByRole("table", { name: "Daily usage and cost", exact: true }).waitFor();
  await rail.getByRole("button", { name: "Agents", exact: true }).click();
  const composer = page.locator('.composer-editor-surface[contenteditable="true"]').first();
  await composer.focus();
  await releaseAnimationFrames();
  assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
  report.cases.push("Leaving Usage before its pending focus frame keeps focus in the chat after disposal.");
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(focusFailures, [], "First-activation focus must pass in each motion mode.");
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
