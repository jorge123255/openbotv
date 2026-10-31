// Drives the real channel view in isolated Storybook with a mock host. No live app or provider.
// bun scripts/channel-send-retry-e2e.ts --url=http://localhost:6006 --label=after
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelCommand } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { chromium } from "playwright-core";

const logger = createOpenBotLogger("channel-send-retry-e2e");

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(argument("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
assert.equal(target.pathname, "/");
const label = argument("label") ?? "after";
assert.match(label, /^[a-z0-9-]+$/);
const channel = argument("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/channel-send-retry-e2e", label);
mkdirSync(output, { recursive: true });
const report: {
  passed: boolean;
  cases: string[];
  pageErrors: string[];
  externalRequests: string[];
  screenshots: string[];
  failure?: string;
} = { passed: false, cases: [], pageErrors: [], externalRequests: [], screenshots: [] };

declare global {
  interface Window {
    channelRetryFixture: {
      channelId: string;
      agentId: string;
      agentName: string;
      attempts: Extract<ChannelCommand, { type: "send" }>[];
      fail: "before" | "after" | null;
    };
  }
}

const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["http:", "https:"].includes(url.protocol) && url.origin !== target.origin) {
    report.externalRequests.push(url.origin);
    return route.abort();
  }
  return route.continue();
});
const retry = page.getByRole("button", { name: "Retry", exact: true });
const composer = page.getByRole("textbox", { name: "Message to channel", exact: true });

async function screenshot(name: string) {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", timeout: 5000 });
  report.screenshots.push(path);
}

async function stored() {
  return page.evaluate(() => window.openbot.agent.readChannel({ channelId: window.channelRetryFixture.channelId }));
}

async function send(text: string, fail: "before" | "after" | null) {
  await page.evaluate((fail) => {
    window.channelRetryFixture.fail = fail;
  }, fail);
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

try {
  await page.goto(new URL("/iframe.html?id=app--expanded-sidebar&viewMode=story", target).href, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  logger.info("Story loaded; waiting for the app.");
  await page.getByRole("tab", { name: "Agents", exact: true }).click({ timeout: 60_000 });
  await page.getByRole("navigation", { name: "Chat list", exact: true }).waitFor();
  logger.info("Creating the mock channel.");
  await page.evaluate(async () => {
    const api = window.openbot.agent;
    const agent = (await api.listAgents())[0];
    if (!agent) throw new Error("The mock app needs one agent.");
    const channelId = crypto.randomUUID();
    window.channelRetryFixture = { channelId, agentId: agent.id, agentName: agent.name, attempts: [], fail: null };
    await api.channelCommand({
      type: "save",
      operationId: crypto.randomUUID(),
      channelId,
      draft: {
        name: "Retry fixture",
        title: "",
        instructions: "",
        members: [{ agentId: agent.id }],
        leadAgentId: agent.id,
      },
    });
    // The generic preview stamps "preview". A local host stamps "local", which the real
    // channel adapter recognizes as this reader. Keep the fixture at that real host boundary.
    const read = api.readChannel;
    api.readChannel = async (input, server) => {
      const page = await read(input, server);
      if (input.channelId !== channelId) return page;
      return {
        ...page,
        messages: page.messages.map((entry) =>
          entry.author.kind === "member" && entry.author.id === "preview"
            ? { ...entry, author: { ...entry.author, id: "local" } }
            : entry,
        ),
      };
    };
    const command = api.channelCommand;
    api.channelCommand = async (input, server) => {
      const fixture = window.channelRetryFixture;
      if (input.type !== "send" || input.channelId !== fixture.channelId) return command(input, server);
      fixture.attempts.push(structuredClone(input));
      const fail = fixture.fail;
      fixture.fail = null;
      if (fail === "before") throw new Error("Synthetic transport failure before acceptance.");
      const result = await command(input, server);
      if (fail === "after") throw new Error("Synthetic transport failure after acceptance.");
      return result;
    };
  });
  await page
    .getByRole("button", { name: /^Retry fixture[, .]/ })
    .first()
    .click();
  await composer.waitFor();
  logger.info("Channel open; testing send recovery.");

  if (argument("case") !== "mentions") {
    // Accepted by the host, but its response was lost. A focus event refreshes the stored page.
    await send("Check the retry fixture.", "after");
    await retry.waitFor();
    const original = await stored();
    assert.equal(original.messages.length, 1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("article").filter({ hasText: "Check the retry fixture.", hasNot: retry }).first().waitFor();
    await screenshot("accepted-response-lost");
    await retry.click();
    await retry.waitFor({ state: "detached", timeout: 10_000 });
    const after = await stored();
    assert.deepEqual(
      after.messages.map((entry) => entry.id),
      original.messages.map((entry) => entry.id),
    );
    assert.deepEqual(
      after.tasks.map((task) => task.id),
      original.tasks.map((task) => task.id),
    );
    const attempts = await page.evaluate(() => window.channelRetryFixture.attempts);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.operationId, attempts[1]?.operationId);
    report.cases.push("Lost response: refresh then Retry confirms the original message and task once.");
    await screenshot("retry-confirmed");

    // A new operation with the same text remains a distinct message. Before-commit failures still retry.
    await send("Check the retry fixture.", "before");
    await retry.waitFor();
    assert.equal((await stored()).messages.length, 1);
    await retry.click();
    await retry.waitFor({ state: "detached", timeout: 10_000 });
    const second = await stored();
    assert.equal(second.messages.length, 2);
    assert.equal(second.tasks.length, 2);
    assert.notEqual(second.messages[0]?.id, second.messages[1]?.id);
    const secondAttempts = await page.evaluate(() => window.channelRetryFixture.attempts);
    assert.equal(secondAttempts.length, 4);
    assert.equal(secondAttempts[2]?.operationId, secondAttempts[3]?.operationId);
    assert.notEqual(secondAttempts[0]?.operationId, secondAttempts[2]?.operationId);
    report.cases.push("Before-acceptance failure retries; repeated text in a new operation stays distinct.");
  }
  const beforeHidden = await stored();
  // Hidden members keep their history and membership, but must leave the address menu.
  const name = await page.evaluate(() => window.channelRetryFixture.agentName);
  await composer.fill("@");
  await page.getByRole("option").filter({ hasText: name }).waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.openbot.agent.setAgentHidden({ agentId: window.channelRetryFixture.agentId, hidden: true }),
  );
  await composer.fill("@");
  await page.getByRole("option").filter({ hasText: name }).waitFor({ state: "detached" });
  assert.equal((await stored()).channel.members.length, 1);
  assert.equal((await stored()).messages.length, beforeHidden.messages.length);
  await screenshot("hidden-member-mentions");
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.openbot.agent.setAgentHidden({ agentId: window.channelRetryFixture.agentId, hidden: false }),
  );
  await composer.fill("@");
  await page.getByRole("option").filter({ hasText: name }).waitFor();
  report.cases.push("Hide removes a member from mentions; restore returns it and preserves membership and history.");
  await screenshot("restored-member-mentions");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await screenshot("failure").catch(() => undefined);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
