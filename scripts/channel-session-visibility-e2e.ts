// Real agent/channel services on temporary SQLite data, with an injected provider boundary.
// node --import tsx scripts/channel-session-visibility-e2e.ts [--expect-baseline]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import {
  type AppServerNotification,
  type AppServerRequest,
  getString,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
} from "../src/backend/protocol";
import { providerFailure, providerSync, requiredString } from "../src/backend/provider-client-effects";
import { TimeoutError } from "../src/backend/with-timeout";

const out = resolve(import.meta.dirname, "../.openbot-build/channel-session-visibility-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-channel-session-"));
const profile = join(root, "profile");
const fixtureHome = join(root, "home");
const executable = join(root, "opencode");
await mkdir(fixtureHome);
await writeFile(executable, "#!/bin/sh\nprintf 'opencode 99.0.0\\n'\n", { mode: 0o755 });
process.env.OPENBOT_OPENCODE_PATH = executable;

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { runCauseEffect } = await import("../src/backend/effect-boundary");

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}
let mode: "healthy" | "missing" | "unclassified" | "timeout" = "healthy";
let sessions = 0;
let sessionRequests = 0;
let starts = 0;
let completedTurns = 0;
const privateMarker = "/fixture/private/provider-state.json";
const secretMarker = "fixture-token-abcdefghijklmnopqrstuvwxyz";

class FixtureProvider extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "opencode";
  running = false;
  start() {
    this.running = true;
  }
  stop() {
    return Effect.sync(() => {
      this.running = false;
    });
  }
  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>) {
    switch (method) {
      case "initialize":
      case "turn/interrupt":
        return providerSync(() => decoder({}));
      case "account/read":
        return providerSync(() => decoder({ account: { type: "opencode" } }));
      case "account/rateLimits/read":
        return providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
      case "model/list":
        return providerSync(() => decoder({ data: [{ model: "opencode/big-pickle", displayName: "Fixture" }] }));
      case "plugin/list":
        return providerSync(() => decoder({ marketplaces: [] }));
      case "thread/start":
        sessionRequests += 1;
        if (mode === "timeout")
          return Effect.fail(
            providerFailure(new TimeoutError(`Fixture session setup timed out: ${privateMarker} ${secretMarker}`)),
          );
        return providerSync(() => decoder({ thread: { id: `ses_fixture${++sessions}` } }));
      case "thread/resume":
        if (mode === "missing")
          return Effect.fail(providerFailure(new Error(`ACP session not found: ${privateMarker} ${secretMarker}`)));
        return providerSync(() => decoder({ thread: { id: requiredString(params, "threadId"), turns: [] } }));
      case "thread/read":
        return providerSync(() => decoder({ thread: { id: requiredString(params, "threadId"), turns: [] } }));
      case "turn/start":
        starts += 1;
        if (mode === "missing")
          return Effect.fail(providerFailure(new Error(`ACP session not found: ${privateMarker} ${secretMarker}`)));
        if (mode === "unclassified")
          return Effect.fail(
            providerFailure(new RequestError(-32603, `Session not found: ${privateMarker} ${secretMarker}`)),
          );
        return providerSync(() => {
          const threadId = requiredString(params, "threadId");
          const turnId = getString(params, "clientUserMessageId") ?? randomUUID();
          this.emit("notification", { method: "turn/started", params: { threadId, turn: { id: turnId } } });
          setImmediate(() => {
            completedTurns += 1;
            this.emit("notification", {
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  type: "agentMessage",
                  id: `answer-${turnId}`,
                  text: "Fixture channel result.",
                  phase: "final_answer",
                },
              },
            });
            this.emit("notification", {
              method: "turn/completed",
              params: { threadId, turn: { id: turnId, status: "completed" } },
            });
          });
          return decoder({ turn: { id: turnId, status: "inProgress" } });
        });
      default:
        return Effect.fail(providerFailure(new Error(`Unused fixture method: ${method}`)));
    }
  }
  notify() {}
  respond(_id: RequestId, _result: unknown) {}
  respondError(_id: RequestId, _error: RpcError) {}
}

const unused = () => Effect.die(new Error("The fixture does not use browser control."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};
const database = new OpenBotDatabase(profile);
const store = new AgentStore(profile, fixtureHome, database);
const mailbox = new MailboxStore(profile, store.sharedRoot, database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "opencode",
  preferredModel: "opencode/big-pickle",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "opencode"),
  clientFactory: (provider) => {
    assert.equal(provider, "opencode");
    return new FixtureProvider();
  },
});
const errors: Extract<AgentEvent, { type: "error" }>[] = [];
service.on("event", (event) => {
  if (event.type === "error") errors.push(event);
});
const report: {
  passed: boolean;
  baseline: boolean;
  cases: string[];
  channelReason?: string | null;
  privateThreadSeparate?: boolean;
  missingSessionStarts?: number;
  unclassifiedStarts?: number;
  timeoutSessionRequests?: number;
  timeoutTurnStarts?: number;
  error?: string;
} = { passed: false, baseline: process.argv.includes("--expect-baseline"), cases: [] };

async function until(label: string, ready: () => boolean) {
  if (ready()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Fixture did not reach ${label}.`)), 20_000);
    const inspect = () => {
      if (ready()) finish();
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      service.off("event", inspect);
      if (error) reject(error);
      else resolve();
    }
    service.on("event", inspect);
    inspect();
  });
}

try {
  await runCauseEffect(service.initialize());
  const agent = await runCauseEffect(
    service.createAgent({
      name: "Session fixture",
      description: "Synthetic channel member.",
      avatarSeed: "session-fixture",
      avatarHue: null,
      initialMessage: "Hello fixture.",
    }),
  );
  await until(
    "the fixture private chat to finish",
    () =>
      completedTurns > 0 &&
      !service
        .listQueue(agent.id)
        .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status)),
  );
  const channelId = randomUUID();
  const actor = { id: "local", name: "Fixture reader" };
  await runCauseEffect(
    service.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name: "Session fixture channel",
          title: "",
          instructions: "",
          members: [{ agentId: agent.id }],
          leadAgentId: agent.id,
        },
      },
      actor,
    ),
  );
  const send = async (text: string, targetChannelId = channelId) => {
    await runCauseEffect(
      service.channels.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId: targetChannelId,
          text,
          recipientAgentId: agent.id,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    const task = service.channels.store.tasks(targetChannelId).find((item) => item.instruction === text);
    assert.ok(task);
    return task.id;
  };
  mode = "missing";
  const before = starts;
  const taskId = await send("Check this synthetic task.");
  await until(
    "the missing-session assignment failure",
    () => service.channels.store.tasks(channelId).find((item) => item.id === taskId)?.state === "failed",
  );
  const task = service.channels.store.tasks(channelId).find((item) => item.id === taskId);
  assert.ok(task);
  report.channelReason = task.error;
  report.missingSessionStarts = starts - before;
  assert.equal(report.missingSessionStarts, 2, "Only the existing pre-prompt session replacement may try once.");
  await until("the agent-scoped provider error", () => errors.some((event) => event.code === "delivery_start_failed"));
  assert.ok(
    errors.some((event) => event.code === "delivery_start_failed" && event.message.includes("session not found")),
  );
  assert.ok(!task.error?.includes(privateMarker));
  assert.ok(!task.error?.includes(secretMarker));
  if (report.baseline) {
    assert.equal(task.error, "The provider could not start this assignment. Resume to try again.");
    report.cases.push("Baseline: channel stores a generic failure while the provider error is agent-scoped.");
  } else {
    assert.match(task.error ?? "", /provider session.*channel task/i);
    report.cases.push(
      "A verified missing session has a safe channel-specific reason, without raw paths or error bodies.",
    );
  }
  const privateSnapshot = await runCauseEffect(service.readConversation(agent.id));
  const context = service.channels.store.context(channelId, agent.id);
  report.privateThreadSeparate = privateSnapshot.threadId !== context.threadId;
  assert.equal(report.privateThreadSeparate, true);
  assert.ok(!privateSnapshot.messages.some((message) => message.text.includes("Check this synthetic task.")));
  assert.equal(starts - before, 2, "Reading the private chat must not start or replay the channel task.");
  report.cases.push(
    "Channel execution and private chat keep separate threads; reading the private chat starts no work.",
  );
  if (!report.baseline) {
    mode = "unclassified";
    const beforeUnclassified = starts;
    const unclassifiedTaskId = await send("Check the unclassified provider refusal.");
    await until(
      "the unclassified provider refusal",
      () => service.channels.store.tasks(channelId).find((item) => item.id === unclassifiedTaskId)?.state === "failed",
    );
    const unclassified = service.channels.store.tasks(channelId).find((item) => item.id === unclassifiedTaskId);
    assert.ok(unclassified);
    report.unclassifiedStarts = starts - beforeUnclassified;
    assert.equal(report.unclassifiedStarts, 1, "A diagnostic mentioning a missing session cannot authorize replay.");
    assert.equal(unclassified.error, "The provider could not start this assignment. Resume to try again.");
    assert.ok(!unclassified.error.includes(privateMarker));
    assert.ok(!unclassified.error.includes(secretMarker));
    report.cases.push("An unclassified protocol error keeps its generic safe reason and is not retried.");

    mode = "timeout";
    const timeoutChannelId = randomUUID();
    await runCauseEffect(
      service.channels.command(
        {
          type: "save",
          operationId: randomUUID(),
          channelId: timeoutChannelId,
          draft: {
            name: "Timed-out session fixture",
            title: "",
            instructions: "",
            members: [{ agentId: agent.id }],
            leadAgentId: agent.id,
          },
        },
        actor,
      ),
    );
    const beforeTimeoutSessions = sessionRequests;
    const beforeTimeoutTurns = starts;
    const timeoutTaskId = await send("Wait for this synthetic session setup.", timeoutChannelId);
    await until(
      "the pre-prompt session preparation timeout",
      () =>
        service.channels.store.tasks(timeoutChannelId).find((item) => item.id === timeoutTaskId)?.state === "failed",
    );
    const timedOut = service.channels.store.tasks(timeoutChannelId).find((item) => item.id === timeoutTaskId);
    assert.ok(timedOut);
    assert.equal(timedOut.error, sourceText("error.backend.channelAssignmentPreparationTimedOut"));
    assert.ok(!timedOut.error?.includes(privateMarker));
    assert.ok(!timedOut.error?.includes(secretMarker));
    report.timeoutSessionRequests = sessionRequests - beforeTimeoutSessions;
    report.timeoutTurnStarts = starts - beforeTimeoutTurns;
    assert.equal(report.timeoutSessionRequests, 1);
    assert.equal(report.timeoutTurnStarts, 0);
    report.cases.push("A session setup timeout is visible on its channel task, sends no prompt and is not retried.");

    mode = "healthy";
    const beforeHealthy = starts;
    const healthyTaskId = await send("Return the synthetic channel result.");
    await until(
      "the channel result",
      () => service.channels.store.tasks(channelId).find((item) => item.id === healthyTaskId)?.state === "completed",
    );
    assert.equal(starts - beforeHealthy, 1);
    const channelMessages = service.channels.store.messages(channelId);
    assert.ok(
      channelMessages.some(
        (entry) => entry.taskId === healthyTaskId && entry.message.text === "Fixture channel result.",
      ),
    );
    const privateAfter = await runCauseEffect(service.readConversation(agent.id));
    assert.deepEqual(privateAfter.messages, privateSnapshot.messages);
    assert.equal(privateAfter.threadId, privateSnapshot.threadId);
    assert.ok(
      channelMessages.some((entry) => entry.taskId === taskId && entry.message.text === "Check this synthetic task."),
    );
    report.cases.push(
      "A later successful channel task publishes its result only in the channel and preserves earlier requests and private history.",
    );
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => undefined);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, report.baseline ? "before.json" : "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
