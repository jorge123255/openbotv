// Checks the real image normalizer, browser reload and reduced-motion rendering.
// Saves and reopens the real AgentStore in a new temporary profile. No Electron or provider starts.
// bun scripts/agent-avatar-ui-e2e.ts --url=http://localhost:6006
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { readScriptArguments } from "./script-arguments";

const args = readScriptArguments({
  usage: "bun scripts/agent-avatar-ui-e2e.ts --url=<local-storybook-url> [--browser-channel=chrome|chromium]",
  options: { url: { type: "string" }, "browser-channel": { type: "string" } },
});
if (!args) process.exit(0);
const target = new URL(args.values.url ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const channel = args.values["browser-channel"] ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/agent-avatar-ui-e2e");
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  frames?: number;
  reloadedFrames?: number;
  storeReloadFrames?: number;
  failure?: string;
} = { passed: false, cases: [], pageErrors: [] };
const browser = await chromium.launch({ channel, headless: true });
const temporary = await mkdtemp(join(tmpdir(), "openbot-avatar-e2e-"));
let store: AgentStore | undefined;
const page = await browser.newPage({ viewport: { width: 1280, height: 880 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin ? route.abort() : route.continue();
});
const fixture =
  "R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBDAABACwAAAAACAAIAIEAgAAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBDAABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7";
async function open(story: string) {
  const url = new URL("/iframe.html", target);
  url.searchParams.set("id", `identity-agentavatar--${story}`);
  url.searchParams.set("viewMode", "story");
  await page.goto(url.href);
}
// ImageDecoder is a browser API; the script's Node project does not declare it.
const frameCount = () =>
  page.evaluate<number>(`(async () => {
  const image = document.querySelector('img');
  if (!image) throw new Error('No saved image.');
  const response = await fetch(image.src);
  const decoder = new ImageDecoder({data: await response.arrayBuffer(), type: 'image/webp'});
  try {await decoder.tracks.ready; return decoder.tracks.selectedTrack.frameCount;} finally {decoder.close();}
})()`);
try {
  await open("saved-animated-image");
  await page.getByRole("button", { name: "Clear saved fixture", exact: true }).click();
  await page
    .getByLabel("Upload avatar fixture", { exact: true })
    .setInputFiles({ name: "three-frames.gif", mimeType: "image/gif", buffer: Buffer.from(fixture, "base64") });
  await page.locator('img[src^="data:image/webp"]').waitFor();
  assert.equal(
    await page.locator(".agent-avatar-mouth").count(),
    0,
    "A custom image must not receive a generated mouth.",
  );
  report.frames = await frameCount();
  assert.equal(report.frames, 3);
  report.cases.push("GIF normalization preserves all three animation frames and does not add a mouth.");
  await page.reload();
  await page.locator('img[src^="data:image/webp"]').waitFor();
  report.reloadedFrames = await frameCount();
  assert.equal(report.reloadedFrames, 3);
  assert.equal(await page.locator(".agent-avatar-mouth").count(), 0);
  report.cases.push("The normalized animated WebP survives browser fixture storage and reload.");
  const imageUrl = await page.locator("img").getAttribute("src");
  assert.ok(imageUrl);
  const normalized = Buffer.from(imageUrl.slice(imageUrl.indexOf(",") + 1), "base64");
  const profile = join(temporary, "profile");
  const home = join(temporary, "home");
  store = new AgentStore(profile, home);
  await runCauseEffect(store.initialize());
  const agent = await runCauseEffect(
    store.createAgent({
      name: "Avatar persistence fixture",
      description: "Offline fixture",
      avatarSeed: "avatar-persistence",
      avatarHue: 245,
    }),
  );
  const saved = await runCauseEffect(
    store.setAvatar(agent.id, { mimeType: "image/webp", bytes: new Uint8Array(normalized) }),
  );
  store.database.close();
  store = new AgentStore(profile, home);
  await runCauseEffect(store.initialize());
  const restored = store.list().find((row) => row.id === agent.id);
  assert.ok(restored);
  assert.equal(restored.avatarUrl, saved.avatarUrl);
  assert.equal(restored.avatarSeed, agent.avatarSeed);
  assert.equal(restored.avatarHue, agent.avatarHue);
  assert.equal(restored.threadId, agent.threadId);
  const resolved = store.resolveAvatar(agent.id);
  assert.ok(resolved);
  const persisted = await readFile(resolved.path);
  assert.equal(persisted.equals(normalized), true, "Store reload must preserve every animation byte.");
  report.storeReloadFrames = await page.evaluate<number>(`(async () => {
    const response = await fetch(${JSON.stringify(`data:image/webp;base64,${persisted.toString("base64")}`)});
    const decoder = new ImageDecoder({data: await response.arrayBuffer(), type:'image/webp'});
    try {await decoder.tracks.ready;return decoder.tracks.selectedTrack.frameCount;} finally {decoder.close();}
  })()`);
  assert.equal(report.storeReloadFrames, 3);
  await runCauseEffect(store.setAvatar(agent.id, null));
  assert.equal(store.resolveAvatar(agent.id), null);
  report.cases.push(
    "The real AgentStore preserves animated image bytes and identity through SQLite/file save and reopen; removing the image restores generated identity.",
  );

  await page.getByRole("button", { name: "Clear saved fixture", exact: true }).click();
  await page.locator(".agent-avatar-mouth").waitFor();
  report.cases.push("Clearing the image restores the generated avatar.");

  await open("pointer-faces");
  await page.getByRole("region", { name: "idle", exact: true }).waitFor();
  // The requested behavior is no frame changes from pointer input with reduced motion.
  // Animation frames are event barriers, not elapsed-time sleeps.
  await page.getByRole("region", { name: "asleep", exact: true }).waitFor();
  const changes = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let changes = 0;
    const observer = new MutationObserver((records) => {
      changes += records.length;
    });
    for (const root of document.querySelectorAll(".agent-avatar-bloub"))
      observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["d", "transform"] });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1200, clientY: 700, pointerType: "mouse" }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    observer.disconnect();
    return changes;
  });
  assert.equal(changes, 0);
  report.cases.push(
    "Generated idle, working, waiting, failed, responded, connecting and asleep faces stay still on pointer input with reduced motion.",
  );
  await page.screenshot({ path: resolve(output, "reduced-motion.png") });
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  store?.database.close();
  try {
    await browser.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
