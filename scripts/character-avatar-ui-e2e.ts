// Real App appearance saves, temporary AgentStore persistence, and character motion gates.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { avatarCharacter, avatarCharacterSeed, bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import { chromium } from "playwright-core";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/character-avatar-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
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
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
const temporary = await mkdtemp(join(tmpdir(), "openbot-character-e2e-"));
let store: AgentStore | undefined;
const open = async (id: string) => {
  await page.goto(new URL(`/iframe.html?id=${id}&viewMode=story`, target).href, { waitUntil: "domcontentloaded" });
};
try {
  const base = "existing-bot-identity";
  for (const kind of ["robot", "orb"] as const) {
    const seed = avatarCharacterSeed(base, kind);
    assert.ok(seed);
    assert.equal(avatarCharacterSeed(seed, "shape"), base);
    assert.deepEqual(bloubAvatarProfile(seed, 245), bloubAvatarProfile(base, 245));
  }
  assert.equal(avatarCharacterSeed("x".repeat(128), "robot"), null);
  store = new AgentStore(join(temporary, "profile"), join(temporary, "home"));
  await runCauseEffect(store.initialize());
  const agent = await runCauseEffect(
    store.createAgent({ name: "Character fixture", description: "Offline fixture", avatarSeed: base, avatarHue: 245 }),
  );
  const seed = avatarCharacterSeed(agent.avatarSeed, "robot");
  assert.ok(seed);
  await runCauseEffect(store.updateAgent({ agentId: agent.id, avatarSeed: seed }));
  store.database.close();
  store = new AgentStore(join(temporary, "profile"), join(temporary, "home"));
  await runCauseEffect(store.initialize());
  const restored = store.list().find((row) => row.id === agent.id);
  assert.ok(restored);
  assert.equal(restored.avatarSeed, seed);
  for (const key of ["name", "description", "avatarHue", "threadId", "workspacePath"] as const)
    assert.equal(restored[key], agent[key]);
  await runCauseEffect(store.updateAgent({ agentId: agent.id, avatarSeed: avatarCharacter(restored.avatarSeed).seed }));
  assert.equal(store.list().find((row) => row.id === agent.id)?.avatarSeed, agent.avatarSeed);
  report.cases.push(
    "Character selection survives real AgentStore reopen, keeps identity/thread/workspace fields, and restores the exact original shape seed.",
  );

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
  await page.locator(".agent-settings-avatar").click();
  await page.getByRole("button", { name: "Orb", exact: true }).click();
  await page.locator('.roster-row-active [data-character="orb"]').waitFor();
  await page.getByRole("button", { name: "Shapes", exact: true }).click();
  await page.locator('.roster-row-active [data-avatar="generated"]').waitFor();
  assert.equal(await page.locator(".roster-row").count(), 3);
  assert.equal(await page.locator(".conversation-title h1").innerText(), "Chief");
  report.cases.push(
    "Orb and Shapes use the same save controls; returning to Shapes retains the selected bot and roster.",
  );

  await page.keyboard.press("Escape");
  await page.locator(".roster-create").click();
  await page.locator(".first-agent-setup-panel").waitFor();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page.locator('.first-agent-live-avatar [data-character="robot"]').waitFor();
  await page.screenshot({ path: resolve(output, "new-bot-character.png") });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".roster-row").first().waitFor();
  assert.equal(await page.locator(".roster-row").count(), 3);
  report.cases.push(
    "The roster New agent action opens the existing creation flow with character choices; cancel creates no bot.",
  );

  await open("identity-agentavatar--living-characters");
  await page.locator('[data-character="robot"]').waitFor();
  const mouths = new Set<string>();
  for (const mood of ["idle", "working", "waiting", "failed", "responded", "connecting", "asleep"]) {
    await page.getByRole("button", { name: mood, exact: true }).click();
    await page.locator(`[data-character="robot"][data-mood="${mood}"]`).waitFor();
    const path = await page.locator('[data-character="robot"] .character-mouth').getAttribute("d");
    assert.ok(path);
    mouths.add(path);
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
  assert.equal(mouths.size, 7);
  await page.getByRole("button", { name: "idle", exact: true }).click();
  report.step = "Start normal-motion character animation";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(
    () => document.querySelector('[data-character="robot"]')?.getAnimations({ subtree: true }).length,
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
  report.cases.push("A custom animated image overrides the character without adding generated face parts.");
  await open("identity-agentavatar--static-characters");
  await page.locator(".character-svg").first().waitFor();
  assert.equal(await page.locator(".character-svg").count(), 2);
  assert.equal(
    await page
      .locator(".character-svg .character-mouth")
      .first()
      .evaluate((e) => e.style.stroke.startsWith("rgb")),
    true,
  );
  const visiblePixels = await page
    .locator(".character-svg")
    .first()
    .evaluate(async (svg) => {
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
  report.cases.push("Static mentions/export artwork retains the selected character with resolved face colors.");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  try {
    store?.database.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await browser.close();
  }
}
