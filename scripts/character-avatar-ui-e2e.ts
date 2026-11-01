// Real App appearance saves, temporary AgentStore persistence, and character motion gates.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AVATAR_CHARACTERS,
  avatarCharacter,
  avatarCharacterSeed,
  bloubAvatarProfile,
} from "@openbot/brand/bloub-avatar";
import { chromium } from "playwright-core";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage:
    "bun scripts/character-avatar-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium] [--identity-only]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" }, "identity-only": { type: "boolean" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/character-avatar-ui-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; failure?: string; step?: string } = {
  passed: false,
  cases: [],
  pageErrors: [],
};
const families = AVATAR_CHARACTERS.filter((kind) => kind !== "shape");
const temporary = await mkdtemp(join(tmpdir(), "openbot-character-e2e-"));
let store: AgentStore | undefined;
try {
  const base = "existing-bot-identity";
  store = new AgentStore(join(temporary, "profile"), join(temporary, "home"));
  await runCauseEffect(store.initialize());
  const agent = await runCauseEffect(
    store.createAgent({ name: "Character fixture", description: "Offline fixture", avatarSeed: base, avatarHue: 245 }),
  );
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD7kAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await runCauseEffect(store.setAvatar(agent.id, { mimeType: "image/png", bytes: image }));
  for (const kind of families) {
    const seed = avatarCharacterSeed(base, kind);
    assert.ok(seed);
    await runCauseEffect(store.updateAgent({ agentId: agent.id, avatarSeed: seed }));
    store.database.close();
    store = new AgentStore(join(temporary, "profile"), join(temporary, "home"));
    await runCauseEffect(store.initialize());
    const restored = store.list().find((row) => row.id === agent.id);
    assert.ok(restored);
    assert.equal(restored.avatarSeed, seed);
    assert.deepEqual(avatarCharacter(restored.avatarSeed), { kind, seed: base });
    assert.equal(avatarCharacterSeed(restored.avatarSeed, "shape"), base);
    // Native consumers still render the exact base shape when they do not draw the family.
    assert.deepEqual(bloubAvatarProfile(restored.avatarSeed, restored.avatarHue), bloubAvatarProfile(base, 245));
    for (const key of ["id", "name", "description", "avatarHue", "avatarUrl", "threadId", "workspacePath"] as const)
      assert.equal(restored[key], uploaded[key]);
    const storedImage = store.resolveAvatar(agent.id);
    assert.ok(storedImage);
    assert.deepEqual(readFileSync(storedImage.path), image);
    assert.equal(avatarCharacterSeed("x".repeat(128), kind), null);
    report.cases.push(
      `${kind}: real AgentStore reopen retains the family, base seed, identity, thread, workspace and uploaded image bytes.`,
    );
  }
  await runCauseEffect(store.updateAgent({ agentId: agent.id, avatarSeed: base }));
  store.database.close();
  store = new AgentStore(join(temporary, "profile"), join(temporary, "home"));
  await runCauseEffect(store.initialize());
  assert.equal(store.list().find((row) => row.id === agent.id)?.avatarSeed, base);
  report.cases.push("Returning to Shapes restores the original seed after database reopen.");
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  writeFileSync(resolve(output, "identity-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  store?.database.close();
  await rm(temporary, { recursive: true, force: true });
}
if (args.values["identity-only"]) {
  report.passed = true;
  writeFileSync(resolve(output, "identity-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
const open = async (id: string) => {
  await page.goto(new URL(`/iframe.html?id=${id}&viewMode=story`, target).href, { waitUntil: "domcontentloaded" });
};
// These bounds checks cover the review defect: text can overlap even without parent overflow.
const assertChatCardLayout = async (replies: number, markers: boolean) => {
  const result = await page.evaluate(() => {
    const errors: string[] = [];
    const visible = (element: Element) => element.getBoundingClientRect().height > 0;
    const check = (container: Element, parts: Element[]) => {
      const frame = container.getBoundingClientRect();
      for (const [index, part] of parts.entries()) {
        const box = part.getBoundingClientRect();
        if (box.left < frame.left - 1 || box.right > frame.right + 1)
          errors.push(`${part.className} extends outside its card`);
        for (const other of parts.slice(index + 1)) {
          const next = other.getBoundingClientRect();
          if (
            Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1 &&
            Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1
          )
            errors.push(`${part.className} overlaps ${other.className}`);
        }
      }
    };
    const rows = [...document.querySelectorAll(".awaiting-replies-item")].filter(visible);
    for (const row of rows) {
      check(
        row,
        [
          ...row.querySelectorAll(".awaiting-replies-name, .awaiting-replies-preview, .awaiting-replies-state, button"),
        ].filter(visible),
      );
      for (const text of row.querySelectorAll<HTMLElement>(
        ".awaiting-replies-name, .awaiting-replies-detail, .awaiting-replies-state-label, button",
      )) {
        if (text.scrollWidth > text.clientWidth + 1) errors.push(`${text.className} clips text`);
      }
    }
    const contents = [...document.querySelectorAll(".chat-action-marker-content")].filter(visible);
    for (const content of contents) {
      check(content, [...content.children].filter(visible));
      for (const time of content.querySelectorAll("time")) {
        if (!time.textContent?.trim() || !time.getAttribute("datetime")) errors.push("Marker lost its date");
      }
    }
    return { errors, replies: rows.length, markers: contents.length };
  });
  assert.deepEqual(result.errors, [], report.step);
  assert.equal(result.replies, replies);
  if (markers) assert.ok(result.markers > 0, "The fixture must include action markers.");
};
try {
  await open("app--roster-workspace");
  await page.locator(".roster-row").first().waitFor({ timeout: 60_000 });
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await page.locator(".conversation-title").click();
  await page.getByRole("button", { name: "Edit agent avatar", exact: true }).click();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page.locator('.roster-row-active [data-character="robot"]').waitFor();
  await page.locator(".companion-stage").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Hide character", exact: true }).click();
  await page.locator(".companion-stage").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Show character", exact: true }).click();
  await page.locator(".companion-stage").waitFor();
  await page.screenshot({ path: resolve(output, "selected-companion.png") });
  report.cases.push(
    "Existing bot settings saves Companion to the real App roster and chat; its character view can hide and reopen.",
  );
  const layoutEditor = page.locator('.composer-editor-surface[contenteditable="true"]').first();
  await layoutEditor.fill("Keep this character layout draft.");
  for (const width of [1280, 1120, 1024]) {
    report.step = `Character beside settings at ${width}px`;
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 800 });
    await page.waitForFunction(() => {
      const stage = document.querySelector<HTMLElement>(".companion-stage");
      const settings = document.querySelector<HTMLElement>(".settings-panel");
      const header = document.querySelector<HTMLElement>(".conversation-header");
      if (!stage || !settings || !header) return false;
      const pane = settings.getBoundingClientRect();
      const area = stage.getBoundingClientRect();
      const bar = header.getBoundingClientRect();
      if (area.right > pane.left + 1 || bar.right > pane.left + 1) return false;
      const contents = stage.querySelectorAll<HTMLElement>(".agent-avatar, .companion-stage-copy, button");
      for (const item of contents) {
        const box = item.getBoundingClientRect();
        if (box.left < area.left - 1 || box.right > area.right + 1) return false;
        if (item.tagName === "BUTTON" && item.scrollWidth > item.clientWidth + 1) return false;
      }
      const buttons = [...header.querySelectorAll("button")].filter(
        (button) => getComputedStyle(button).visibility === "visible" && button.getClientRects().length > 0,
      );
      for (const [index, button] of buttons.entries()) {
        const box = button.getBoundingClientRect();
        if (box.left < bar.left - 1 || box.right > bar.right + 1) return false;
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        if (!hit || !button.contains(hit)) return false;
        for (const other of buttons.slice(index + 1)) {
          const next = other.getBoundingClientRect();
          if (
            Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1 &&
            Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1
          )
            return false;
        }
      }
      return buttons.length > 0;
    });
    await assertChatCardLayout(2, true);
    await page.screenshot({ path: resolve(output, `character-settings-${width}.png`) });
  }
  await page.getByRole("button", { name: "Maximize side panel", exact: true }).click();
  await page.locator(".companion-stage").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Restore side panel", exact: true }).click();
  await page.locator(".companion-stage").waitFor();
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await page.locator(".settings-panel").waitFor({ state: "hidden" });
  assert.equal(await layoutEditor.innerText(), "Keep this character layout draft.");
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.locator(".companion-stage").getByRole("button", { name: "Edit agent avatar", exact: true }).click();
  await page.locator(".settings-panel").waitFor();
  assert.equal(await page.locator(".conversation-title h1").innerText(), "Chief");
  report.cases.push(
    "At 1280, 1120 and 1024px, the character stays beside settings and header controls remain separate and hittable; maximize/restore and close preserve the selected chat and draft.",
  );

  await page.locator(".agent-settings-avatar").click();
  await page.getByRole("button", { name: "Orb", exact: true }).click();
  await page.locator('.roster-row-active [data-character="orb"]').waitFor();
  for (const [name, kind] of [
    ["Pebble", "pebble"],
    ["Wisp", "wisp"],
    ["Sprout", "sprout"],
    ["Comet", "comet"],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.locator(`.roster-row-active [data-character="${kind}"]`).waitFor();
    assert.equal(await page.locator(`.companion-stage [data-character="${kind}"]`).count(), 1);
    assert.equal(await page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: resolve(output, `studio-${kind}.png`) });
  }
  await page.getByRole("button", { name: "Shapes", exact: true }).click();
  await page.locator('.roster-row-active [data-avatar="generated"]').waitFor();
  assert.equal(await page.locator(".roster-row").count(), 3);
  assert.equal(await page.locator(".conversation-title h1").innerText(), "Chief");
  report.cases.push(
    "Orb, Pebble, Wisp, Sprout, Comet and Shapes save through the real App; returning to Shapes retains the selected agent and roster.",
  );

  await page.keyboard.press("Escape");
  await page.locator(".roster-create").click();
  await page.locator(".first-agent-setup-panel").waitFor();
  assert.equal(
    await page.locator('.first-agent-live-avatar [data-avatar="generated"]').count(),
    1,
    "New agents keep the original default identity.",
  );
  for (const [name, kind] of [
    ["Pebble", "pebble"],
    ["Wisp", "wisp"],
    ["Sprout", "sprout"],
    ["Comet", "comet"],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.locator(`.first-agent-live-avatar [data-character="${kind}"]`).waitFor();
  }
  await page.locator(".first-agent-live-avatar").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "new-bot-character.png") });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".roster-row").first().waitFor();
  assert.equal(await page.locator(".roster-row").count(), 3);
  report.cases.push(
    "The roster New agent action opens the existing creation flow with character choices; cancel creates no bot.",
  );

  await open("app--companion-turn-states");
  await page.locator(".companion-stage").waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  const editor = page.locator('.composer-editor-surface[contenteditable="true"]').first();
  await editor.fill("Fail this offline fixture turn.");
  await editor.press("Enter");
  await page.locator('.roster-row-active [data-mood="failed"]').waitFor();
  assert.equal(
    await page.locator(".companion-stage [data-character]").getAttribute("data-mood"),
    "failed",
    "A failed turn must show the same failed character in chat and roster.",
  );
  assert.equal(await page.locator(".conversation-title [data-character]").getAttribute("data-mood"), "failed");
  await page.screenshot({ path: resolve(output, "failed-turn-integration.png") });
  report.cases.push(
    "A failed turn through the real composer and host event bridge gives the chat character, title and roster the same failure mood.",
  );
  await editor.fill("Complete this offline fixture turn.");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await editor.press("Enter");
  await page.locator('.roster-row-active [data-mood="responded"]').waitFor();
  assert.equal(
    await page.locator(".companion-stage [data-character]").getAttribute("data-mood"),
    "responded",
    "A completed unread reply must reach the chat character.",
  );
  await page.screenshot({ path: resolve(output, "reply-turn-integration.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator('.roster-row-active [data-mood="idle"]').waitFor();
  assert.equal(await page.locator(".companion-stage [data-character]").getAttribute("data-mood"), "idle");
  report.cases.push(
    "A completed reply shares the roster reply mood, and returning focus restores both characters to idle.",
  );

  await open("conversation-awaiting-replies--narrow-long-names");
  await page.locator(".awaiting-replies-item").first().waitFor();
  const replyHeader = page.locator(".awaiting-replies .task-list-header");
  for (const width of [240, 320]) {
    report.step = `Long reply names at ${width}px`;
    await page.setViewportSize({ width, height: 1000 });
    await assertChatCardLayout(4, false);
    assert.deepEqual(
      await page
        .locator(".awaiting-replies-item")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-state"))),
      ["replied", "working", "failed", "asked"],
    );
    await replyHeader.focus();
    for (const button of await page.locator(".awaiting-replies-item button").all()) {
      await page.keyboard.press("Tab");
      await button.scrollIntoViewIfNeeded();
      assert.equal(await button.evaluate((element) => element === document.activeElement), true);
      assert.ok(await button.getAttribute("aria-labelledby"), "Reply actions retain the agent name.");
      await button.click({ trial: true });
    }
    await page.screenshot({ path: resolve(output, `narrow-reply-cards-${width}.png`), fullPage: true });
  }
  await replyHeader.click();
  assert.equal(await replyHeader.getAttribute("aria-expanded"), "false");
  await replyHeader.click();
  assert.equal(await replyHeader.getAttribute("aria-expanded"), "true");
  await assertChatCardLayout(4, false);
  report.cases.push(
    "Narrow chat cards keep names, states, actions and marker dates separate; long-name reply actions remain keyboard reachable and the list can close and reopen.",
  );
  await page.setViewportSize({ width: 1672, height: 941 });

  await open("identity-agentavatar--living-characters");
  await page.locator('[data-character="robot"]').waitFor();
  const mouths = new Map(families.map((kind) => [kind, new Set<string>()] as const));
  for (const mood of ["idle", "working", "waiting", "failed", "responded", "connecting", "asleep"]) {
    await page.getByRole("button", { name: mood, exact: true }).click();
    for (const kind of families) {
      const character = page.locator(`[data-character="${kind}"][data-mood="${mood}"]`);
      await character.waitFor();
      const path = await character.locator(".character-mouth").getAttribute("d");
      assert.ok(path);
      mouths.get(kind)?.add(path);
      assert.equal(
        await character.locator(".character-face").evaluate((face) => {
          const svg = face.closest("svg");
          if (!svg) return false;
          const area = svg.getBoundingClientRect();
          const box = face.getBoundingClientRect();
          return box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom;
        }),
        true,
        `${kind} keeps its ${mood} face inside the artwork.`,
      );
    }
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".agent-avatar-character")].every(
        (element) => element.getAnimations({ subtree: true }).length === 0,
      ),
    );
    assert.equal(
      await page
        .locator('[data-character="robot"] .character-arm-right')
        .evaluate((element) => getComputedStyle(element).animationName),
      "none",
      `Reduced motion must stop every ${mood} pose.`,
    );
    await page.screenshot({ path: resolve(output, `characters-${mood}.png`) });
  }
  for (const paths of mouths.values()) assert.equal(paths.size, 7);
  await page.getByRole("button", { name: "idle", exact: true }).click();
  report.step = "Start normal-motion character animation";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".agent-avatar-character")].every(
      (element) => element.getAnimations({ subtree: true }).length > 0,
    ),
  );
  report.step = "Follow the pointer in normal motion";
  await page.mouse.move(50, 500);
  await page.mouse.move(1400, 500);
  await page.waitForFunction(
    () =>
      Math.abs(
        Number.parseFloat(
          document
            .querySelector<HTMLElement>('[data-character="robot"]')
            ?.style.getPropertyValue("--character-look-x") ?? "0",
        ),
      ) > 0,
  );
  report.step = "Stop character animation on reduced motion";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".agent-avatar-character")].every(
      (element) => element.getAnimations({ subtree: true }).length === 0,
    ),
  );
  report.step = "Reset character gaze on reduced motion";
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>(".agent-avatar-character")].every(
      (element) =>
        element.style.getPropertyValue("--character-look-x") === "0px" &&
        element.style.getPropertyValue("--character-look-y") === "0px",
    ),
  );
  const before = await page
    .locator(".agent-avatar-character")
    .evaluateAll((elements) => elements.map((e) => e.getAttribute("style")));
  await page.mouse.move(50, 500);
  assert.deepEqual(
    await page
      .locator(".agent-avatar-character")
      .evaluateAll((elements) => elements.map((e) => e.getAttribute("style"))),
    before,
  );
  report.cases.push(
    "Seven distinct mouth states, live normal-motion animation/gaze, and no character animation or pointer movement under reduced motion.",
  );

  await open("identity-agentavatar--character-image");
  await page.locator(".agent-avatar-custom img").waitFor();
  assert.equal(await page.locator(".agent-avatar-character, .agent-avatar-mouth").count(), 0);
  await open("identity-agentavatar--character-image-families");
  await page.locator(".agent-avatar-custom img").first().waitFor();
  assert.equal(await page.locator(".agent-avatar-custom img").count(), AVATAR_CHARACTERS.length);
  assert.equal(await page.locator(".agent-avatar-character, .agent-avatar-mouth").count(), 0);
  report.cases.push("A custom animated image overrides every family without adding generated face parts.");
  await open("identity-agentavatar--static-characters");
  await page.locator(".character-svg").first().waitFor();
  assert.equal(await page.locator(".character-svg").count(), families.length);
  assert.equal(
    await page
      .locator(".character-svg .character-mouth")
      .first()
      .evaluate((e) => e.style.stroke.startsWith("rgb")),
    true,
  );
  for (const svg of await page.locator(".character-svg").all()) {
    const visiblePixels = await svg.evaluate(async (svg) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 160;
      const context = canvas.getContext("2d");
      if (!context) return 0;
      context.drawImage(image, 0, 0, 160, 160);
      const pixels = context.getImageData(0, 0, 160, 160).data;
      return pixels.filter((value, index) => index % 4 === 3 && value > 0).length;
    });
    assert.ok(visiblePixels > 1000, "Exported character SVG must rasterize without external styles.");
  }
  report.cases.push("Static mentions/export artwork retains the selected character with resolved face colors.");
  await open("app--bot-ai-workspace");
  await page.locator(".roster-row-active [data-character=pebble]").waitFor();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  for (const width of [1672, 1280, 1024]) {
    await page.setViewportSize({ width, height: 941 });
    assert.equal(await page.locator(".roster-row").count(), 3);
    assert.equal(await page.locator(".conversation-title h1").innerText(), "Chief");
    await page.screenshot({ path: resolve(output, `botai-workspace-${width}.png`) });
  }
  report.cases.push(
    "The real BotAI shell keeps the vertical roster, selected chat and soft characters at three review sizes.",
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => undefined);
  await page
    .evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          ".conversation-header, .conversation-header button, .companion-stage, .companion-stage button, .settings-panel, .awaiting-replies-item, .awaiting-replies-name, .awaiting-replies-state, .chat-action-marker-content, .chat-action-marker-content > *",
        ),
      ].map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          element: element.tagName,
          className: element.className,
          label: element.getAttribute("aria-label"),
          bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          visibility: style.visibility,
          display: style.display,
          opacity: style.opacity,
          hitElement: hit?.tagName,
          hitButton: hit?.closest("button")?.getAttribute("aria-label"),
        };
      }),
    )
    .then((geometry) => writeFileSync(resolve(output, "failure-geometry.json"), JSON.stringify(geometry, null, 2)))
    .catch(() => undefined);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
