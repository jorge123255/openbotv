// Host shell, screenshot, and file actions on this computer.
// bun scripts/host-tool-local-exec-e2e.ts
import assert from "node:assert/strict";
import { readFileSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeHostToolAnswer } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { renderStep } from "../src/backend/agent/handoff-tool-steps";
import { toolProgressText } from "../src/backend/agent/thread-items";
import { grokLocalExecHeaders } from "../src/backend/grok-bot/grok-bot-agent-client";
import { hostToolRequestFromCatalog } from "../src/backend/host-tools/host-tool-catalog";
import { closeBackgroundShells, executeHostAction } from "../src/backend/host-tools/host-tool-executor";
import { thisComputer } from "../src/backend/host-tools/host-tool-machines";
import { HostToolPolicy } from "../src/backend/host-tools/host-tool-policy";
import { handleLocalExecFrame } from "../src/backend/host-tools/host-tool-runner";
import type { HostToolRequest, HostToolRow } from "../src/backend/host-tools/host-tool-types";
import { runLocalExecClient } from "../src/backend/host-tools/local-exec-client";
import type { LocalExecRequestFrame } from "../src/backend/host-tools/local-exec-frames";

const checks: string[] = [];

function mark(name: string): void {
  checks.push(name);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForContents(file: string, needle: string): Promise<string> {
  const deadline = AbortSignal.timeout(5_000);
  const ready = async (): Promise<string | null> => {
    const text = await readFile(file, "utf8").catch(() => "");
    return text.includes(needle) ? text : null;
  };
  const found = await ready();
  if (found !== null) return found;
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(file), () => {
      void ready().then((text) => {
        if (text === null) return;
        watcher.close();
        resolve(text);
      });
    });
    deadline.addEventListener("abort", () => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${needle} in ${file}`));
    });
  });
}

function shellExitCode(message: unknown): number | undefined {
  if (!isDynamicRecord(message)) return undefined;
  const shellResult = message.shellResult;
  if (!isDynamicRecord(shellResult)) return undefined;
  const success = shellResult.success;
  if (!isDynamicRecord(success) || !isNumber(success.exitCode)) return undefined;
  return success.exitCode;
}

function readContent(message: unknown): string | undefined {
  if (!isDynamicRecord(message)) return undefined;
  const readResult = message.readResult;
  if (!isDynamicRecord(readResult)) return undefined;
  const success = readResult.success;
  if (!isDynamicRecord(success) || !isString(success.content)) return undefined;
  return success.content;
}

function hasReadError(message: unknown): boolean {
  if (!isDynamicRecord(message)) return false;
  const readResult = message.readResult;
  if (!isDynamicRecord(readResult)) return false;
  return readResult.error !== undefined;
}

function request(partial: Pick<HostToolRequest, "id" | "action"> & Partial<HostToolRequest>): HostToolRequest {
  return { agentId: "a", threadId: "t", turnId: "u", ...partial };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function checkLocalExecChannel(): Promise<void> {
  const posts: unknown[] = [];
  const headerBlocks: string[] = [];
  let openGets = 0;
  let getCount = 0;
  let notify = (): void => undefined;
  const posted = new Promise<void>((resolve) => {
    notify = () => {
      if (posts.length >= 2) resolve();
    };
  });
  const computer = thisComputer();
  const welcome = `data: ${JSON.stringify({ kind: "welcome", providerId: "prov-1" })}\n\n`;
  const exec = `data: ${JSON.stringify({
    kind: "exec",
    requestId: "req-9",
    serverMessage: { message: { case: "shellStreamArgs", value: { command: "echo host-tool-ok" } } },
  })}\n\n`;
  const server = createServer((req, res) => {
    void handleGateway(req, res);
  });

  async function handleGateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    headerBlocks.push(JSON.stringify(req.headers));
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/local-exec/requests")) {
      getCount += 1;
      if (openGets > 0) {
        res.writeHead(409);
        res.end();
        return;
      }
      openGets += 1;
      req.on("close", () => {
        openGets -= 1;
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(welcome);
      res.write(exec);
      return;
    }
    if (req.method === "POST" && url.startsWith("/local-exec/responses")) {
      posts.push(JSON.parse(await readBody(req)));
      notify();
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fake gateway has no port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const session = {
    token: "gateway-bearer",
    headers: { "x-anyrun-network-token": "net-1" },
    accessToken: "user-sand-access-token",
  };
  const abort = new AbortController();
  let receiver = "none";
  try {
    const first = runLocalExecClient({
      baseUrl,
      session,
      signal: abort.signal,
      hello: () => ({
        kind: "hello",
        localRoot: "/tmp",
        terminalsFolder: "/tmp",
        computerId: computer.id,
        label: computer.label,
      }),
      onFrame: async (frame) => {
        receiver = "first";
        if (frame.kind !== "exec") return null;
        return { kind: "client", requestId: frame.requestId, message: { ok: true } };
      },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The gateway client posted no frames.")), 5_000);
      void posted.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await assert.rejects(
      runLocalExecClient({
        baseUrl,
        session,
        signal: AbortSignal.timeout(2_000),
        hello: () => ({
          kind: "hello",
          localRoot: "/tmp",
          terminalsFolder: "/tmp",
          computerId: computer.id,
          label: computer.label,
        }),
        onFrame: async () => {
          receiver = "second";
          return null;
        },
      }),
      (error: unknown) =>
        error instanceof Error && error.message === sourceText("error.backend.hostToolMachineOffline"),
    );
    assert.equal(receiver, "first");
    assert.equal(getCount, 2);
    const frames = posts.flatMap((post) => (isDynamicRecord(post) && Array.isArray(post.frames) ? post.frames : []));
    const hello = frames.find((frame) => isDynamicRecord(frame) && frame.kind === "hello");
    const client = frames.find((frame) => isDynamicRecord(frame) && frame.kind === "client");
    assert.ok(isDynamicRecord(hello));
    assert.equal(hello.computerId, computer.id);
    assert.ok(isDynamicRecord(client));
    assert.equal(client.requestId, "req-9");
    assert.ok(headerBlocks.length > 0);
    for (const block of headerBlocks) {
      assert.equal(block.includes("user-sand-access-token"), false);
      assert.equal(block.includes("accessToken"), false);
    }
    assert.ok(headerBlocks.some((block) => block.includes("Bearer gateway-bearer")));
    assert.ok(headerBlocks.some((block) => block.includes("net-1")));
    abort.abort();
    await first;
    assert.equal(getCount, 2);
  } finally {
    abort.abort();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function checkCatalog(): void {
  const context = { id: "tool-1", agentId: "a", threadId: "t", turnId: "u" };
  const shell = hostToolRequestFromCatalog("host_shell", { command: "echo host-tool-ok", machineId: "Mac" }, context);
  assert.equal(typeof shell, "object");
  assert.ok(shell);
  if (typeof shell === "string") throw new Error("host_shell returned text.");
  assert.equal(shell.action, "shell");
  assert.equal(shell.command, "echo host-tool-ok");
  assert.equal(shell.machineId, "Mac");
  const shot = hostToolRequestFromCatalog("host_screenshot", {}, context);
  assert.ok(shot && typeof shot !== "string");
  assert.equal(shot.action, "screenshot");
  assert.equal("machineId" in shot, false);
  const read = hostToolRequestFromCatalog("host_read_file", { path: "notes.txt" }, context);
  assert.ok(read && typeof read !== "string" && read.action === "read-file");
  const list = hostToolRequestFromCatalog("host_list_directory", { path: "." }, context);
  assert.ok(list && typeof list !== "string" && list.action === "list-directory");
  const write = hostToolRequestFromCatalog("host_write_file", { path: "a.txt", fileText: "hi" }, context);
  assert.ok(write && typeof write !== "string");
  assert.equal(write.action, "write-file");
  assert.equal(write.fileText, "hi");
  const input = hostToolRequestFromCatalog("host_send_input", { chars: "y" }, context);
  assert.ok(input && typeof input !== "string" && input.action === "send-input" && input.chars === "y");
  assert.equal(hostToolRequestFromCatalog("host_list_machines", {}, context), JSON.stringify([thisComputer()]));
  assert.equal(hostToolRequestFromCatalog("capture_screen", {}, context), null);
}

function shellExec(id: string, machineId?: string): LocalExecRequestFrame {
  return {
    kind: "exec",
    requestId: id,
    serverMessage: { message: { case: "shellStreamArgs", value: { command: "echo host-tool-ok" } } },
    ...(machineId === undefined ? {} : { machineId }),
  };
}

async function checkRunner(): Promise<void> {
  const computer = thisComputer();
  const context = { agentId: "agent-1", threadId: "thread-1", turnId: "turn-1" };
  const exitLine = sourceText("status.agent.hostToolExit", { code: "0" });

  async function runCase(
    frame: LocalExecRequestFrame,
    prepare: (policy: HostToolPolicy) => void,
    ask: () => Promise<"allow-once" | "always" | "never" | "expired">,
  ): Promise<{ rows: HostToolRow[]; runs: number; asks: number; policy: HostToolPolicy }> {
    const policy = new HostToolPolicy();
    prepare(policy);
    const rows: HostToolRow[] = [];
    let runs = 0;
    let asks = 0;
    await handleLocalExecFrame(
      frame,
      {
        policy,
        computer,
        execute: {
          root: tmpdir(),
          computer,
          run: async () => {
            runs += 1;
            return { code: 0, stdout: "host-tool-ok\n", stderr: "" };
          },
          capture: async () => ({ denied: true }),
          writeShot: async () => ({ path: "", thumbnailPath: "" }),
        },
        now: () => Date.now(),
        ask: async () => {
          asks += 1;
          return ask();
        },
        emitRow: (row) => {
          rows.push(row);
        },
      },
      context,
    );
    return { rows, runs, asks, policy };
  }

  const device = await runCase(
    { kind: "device", requestId: "d1", request: { operation: "messages" } },
    (policy) => policy.allowAlways("shell", "ap-device"),
    async () => "allow-once",
  );
  assert.equal(device.rows[0]?.text, sourceText("error.backend.hostToolRefused"));
  assert.equal(device.runs, 0);
  assert.equal(device.asks, 0);
  assert.equal(device.policy.decide("shell"), "always");

  const upload = await runCase(
    { kind: "upload", requestId: "u1", path: "/tmp/a", bytesBase64: "YQ==" },
    (policy) => policy.allowAlways("write-file", "ap-upload"),
    async () => "allow-once",
  );
  assert.equal(upload.rows[0]?.text, sourceText("error.backend.hostToolRefused"));
  assert.equal(upload.runs, 0);
  assert.equal(upload.policy.decide("write-file"), "always");

  const download = await runCase(
    { kind: "download", requestId: "n1", path: "/tmp/a" },
    (policy) => policy.allowAlways("read-file", "ap-download"),
    async () => "allow-once",
  );
  assert.equal(download.rows[0]?.text, sourceText("error.backend.hostToolRefused"));
  assert.equal(download.runs, 0);
  assert.equal(download.policy.decide("read-file"), "always");

  const once = await runCase(
    shellExec("once"),
    () => undefined,
    async () => "allow-once",
  );
  assert.equal(once.runs, 1);
  assert.equal(once.asks, 1);
  assert.ok(once.rows[0]?.text.includes("host-tool-ok"));
  assert.ok(once.rows[0]?.text.includes(exitLine));

  const always = await runCase(
    shellExec("always"),
    (policy) => policy.allowAlways("shell", "ap-always"),
    async () => "allow-once",
  );
  assert.equal(always.runs, 1);
  assert.equal(always.asks, 0);
  assert.ok(always.rows[0]?.text.includes("host-tool-ok"));

  const never = await runCase(
    shellExec("never"),
    (policy) => policy.denyForever("shell"),
    async () => "allow-once",
  );
  assert.equal(never.runs, 0);
  assert.equal(never.asks, 0);
  assert.equal(never.rows[0]?.text, sourceText("error.backend.hostToolDenied"));

  const askNever = await runCase(
    shellExec("ask-never"),
    () => undefined,
    async () => "never",
  );
  assert.equal(askNever.runs, 0);
  assert.equal(askNever.rows[0]?.text, sourceText("error.backend.hostToolDenied"));
  assert.equal(askNever.policy.decide("shell"), "never");

  const expired = await runCase(
    shellExec("expired"),
    () => undefined,
    async () => "expired",
  );
  assert.equal(expired.runs, 0);
  assert.equal(expired.rows[0]?.text, sourceText("error.backend.hostToolDenied"));
  assert.equal(expired.policy.decide("shell"), "ask");

  const retired = new HostToolPolicy();
  retired.allowAlways("shell", "ap-retire");
  const retiredRows: HostToolRow[] = [];
  let retiredRuns = 0;
  let retiredAsks = 0;
  const retiredDeps = {
    policy: retired,
    computer,
    execute: {
      root: tmpdir(),
      computer,
      run: async () => {
        retiredRuns += 1;
        return { code: 0, stdout: "host-tool-ok\n", stderr: "" };
      },
      capture: async () => ({ denied: true as const }),
      writeShot: async () => ({ path: "", thumbnailPath: "" }),
    },
    now: () => Date.now(),
    ask: async () => {
      retiredAsks += 1;
      return "allow-once" as const;
    },
    emitRow: (row: HostToolRow) => {
      retiredRows.push(row);
    },
  };
  await handleLocalExecFrame(shellExec("retire-before"), retiredDeps, context);
  assert.equal(retiredRuns, 1);
  assert.equal(retiredAsks, 0);
  await handleLocalExecFrame({ kind: "retire-approval", approvalId: "ap-retire" }, retiredDeps, context);
  await handleLocalExecFrame(shellExec("retire-after"), retiredDeps, context);
  assert.equal(retiredAsks, 1);

  const other = await runCase(
    shellExec("other", "other-mac"),
    (policy) => policy.allowAlways("shell", "ap-other"),
    async () => "allow-once",
  );
  assert.equal(other.runs, 0);
  assert.equal(other.asks, 0);
  assert.equal(other.rows[0]?.text, sourceText("error.backend.hostToolMachineUnavailable"));
}

const root = await mkdtemp(join(tmpdir(), "host-tool-exec-"));
try {
  assert.deepEqual(thisComputer("Mac"), { id: "Mac", label: "Mac", connected: true });
  assert.deepEqual(thisComputer("  "), { id: "this-computer", label: "this computer", connected: true });
  mark("this-computer");

  const computer = { id: "Mac", label: "Mac", connected: true };
  let runs = 0;
  const shell = await executeHostAction(request({ id: "s1", action: "shell", command: "echo host-tool-ok" }), {
    root,
    computer,
    run: async () => {
      runs += 1;
      return { code: 0, stdout: "host-tool-ok\n", stderr: "" };
    },
    capture: async () => ({ denied: true }),
    writeShot: async () => ({ path: "", thumbnailPath: "" }),
  });
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.stdout, "host-tool-ok\n");
  assert.equal(shellExitCode(shell.message), 0);
  assert.equal(shell.text, `host-tool-ok\n${sourceText("status.agent.hostToolExit", { code: "0" })}`);
  mark("shell");

  const denied = await executeHostAction(request({ id: "shot-deny", action: "screenshot" }), {
    root,
    computer,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    capture: async () => ({ denied: true }),
    writeShot: async () => ({ path: join(root, "should-not-exist.png"), thumbnailPath: join(root, "thumb.png") }),
  });
  assert.equal(denied.text, sourceText("error.backend.hostToolScreenCaptureDenied"));
  assert.equal(denied.path, undefined);
  mark("screenshot-denied");

  const png = Buffer.from([1, 2, 3]);
  const shotDir = join(root, "shots");
  await mkdir(shotDir);
  const captured = await executeHostAction(request({ id: "shot-ok", action: "screenshot" }), {
    root,
    computer,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    capture: async () => ({ png, thumbnailPng: png }),
    writeShot: async (bytes, thumbnail) => {
      const path = join(shotDir, "screen.png");
      const thumbnailPath = join(shotDir, "thumb.png");
      await writeFile(path, bytes);
      await writeFile(thumbnailPath, thumbnail);
      return { path, thumbnailPath };
    },
  });
  const screenStat = await readFile(captured.path ?? "");
  const thumbStat = await readFile(captured.thumbnailPath ?? "");
  assert.deepEqual(Buffer.from(screenStat), png);
  assert.deepEqual(Buffer.from(thumbStat), png);
  assert.ok(captured.path);
  assert.ok(captured.thumbnailPath);
  assert.ok(captured.text.includes(captured.path));
  assert.ok(captured.text.includes(captured.thumbnailPath));
  assert.equal(JSON.stringify(captured.message).includes(png.toString("base64")), false);
  mark("screenshot-files");

  let otherRuns = 0;
  const other = await executeHostAction(
    request({ id: "other", action: "shell", command: "echo no", machineId: "other-mac" }),
    {
      root,
      computer,
      run: async () => {
        otherRuns += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
      capture: async () => ({ denied: true }),
      writeShot: async () => ({ path: "", thumbnailPath: "" }),
    },
  );
  assert.equal(otherRuns, 0);
  assert.equal(other.text, sourceText("error.backend.hostToolMachineUnavailable"));
  mark("other-machine");

  const inside = join(root, "notes.txt");
  await writeFile(inside, "inside-note");
  const outsideDir = await mkdtemp(join(tmpdir(), "host-tool-outside-"));
  const outside = join(outsideDir, "secret.txt");
  await writeFile(outside, "outside-secret");
  const readDeps = {
    root,
    computer,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    capture: async () => ({ denied: true as const }),
    writeShot: async () => ({ path: "", thumbnailPath: "" }),
  };
  const readInside = await executeHostAction(
    request({ id: "read-in", action: "read-file", path: "notes.txt" }),
    readDeps,
  );
  assert.equal(readContent(readInside.message), "inside-note");
  const readOutside = await executeHostAction(
    request({ id: "read-out", action: "read-file", path: outside }),
    readDeps,
  );
  assert.equal(hasReadError(readOutside.message), true);
  assert.equal(JSON.stringify(readOutside.message).includes("outside-secret"), false);
  mark("read-contain");

  const ready = join(root, "ready.txt");
  const marker = join(root, "stdin.txt");
  const script = join(root, "listen.cjs");
  await writeFile(
    script,
    `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(ready)}, "ready");\nprocess.stdin.on("data", (chunk) => fs.appendFileSync(${JSON.stringify(marker)}, chunk));\n`,
  );
  const background = await executeHostAction(
    request({
      id: "bg",
      action: "shell",
      command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
      isBackground: true,
    }),
    readDeps,
  );
  await waitForContents(ready, "ready");
  const shellIdMatch = /shell (\d+)/u.exec(background.text);
  assert.ok(shellIdMatch);
  const shellId = Number(shellIdMatch[1]);
  const sent = await executeHostAction(request({ id: "stdin", action: "send-input", shellId, chars: "hi" }), readDeps);
  assert.equal(await waitForContents(marker, "hi"), "hi");
  const unknown = await executeHostAction(
    request({ id: "stdin-missing", action: "send-input", shellId: 999_999, chars: "nope" }),
    readDeps,
  );
  assert.equal(unknown.text, sourceText("error.backend.hostToolMachineUnavailable"));
  assert.equal(await readFile(marker, "utf8"), "hi");
  assert.equal(sent.ok, true);
  mark("background-stdin");

  assert.equal(runs, 1);
  await rm(outsideDir, { recursive: true, force: true });
  await checkLocalExecChannel();
  mark("local-exec-channel");
  await checkRunner();
  mark("runner-gate");
  assert.deepEqual(decodeHostToolAnswer({ requestId: "r1", decision: "allow-once" }), {
    requestId: "r1",
    decision: "allow-once",
  });
  assert.equal(decodeHostToolAnswer({ requestId: "r1", decision: "accept" }), null);
  assert.equal(decodeHostToolAnswer({ requestId: "r1", decision: "allow-once", gatewayToken: "secret" }), null);
  assert.equal(decodeHostToolAnswer({ requestId: "r1", decision: "allow-once", accessToken: "secret" }), null);
  mark("answer-decode");
  checkCatalog();
  mark("catalog");
  const drivers = readFileSync("src/backend/provider-drivers.ts", "utf8");
  const grokStart = drivers.indexOf('id: "grok-bot"');
  const grokEnd = drivers.indexOf('id: "acp"', grokStart);
  const grokBlock = drivers.slice(grokStart, grokEnd);
  assert.equal(grokBlock.includes("directInference"), false);
  const clientSource = readFileSync("src/backend/grok-bot/grok-bot-agent-client.ts", "utf8");
  assert.equal(clientSource.includes("sendGrokBotPrompt"), true);
  assert.equal(clientSource.includes('namespace: "sand"'), true);
  const gatewaySession = {
    token: "gateway-bearer",
    headers: { "x-anyrun-network-token": "net-1" },
    accessToken: "user-sand-access-token",
  };
  const gatewayHeaders = grokLocalExecHeaders(gatewaySession);
  assert.equal(gatewayHeaders.authorization, "Bearer gateway-bearer");
  assert.equal(gatewayHeaders["x-anyrun-network-token"], "net-1");
  assert.equal(JSON.stringify(gatewayHeaders).includes("user-sand-access-token"), false);
  mark("grok-gateway");
  const shellItem = {
    type: "dynamicToolCall",
    id: "s1",
    namespace: "host",
    tool: "host_shell",
    status: "completed",
    contentItems: [{ type: "inputText", text: "host-tool-ok\nexit 0" }],
  };
  assert.equal(toolProgressText(shellItem, true), "host-tool-ok\nexit 0");
  const shotItem = {
    type: "dynamicToolCall",
    id: "p1",
    namespace: "host",
    tool: "host_screenshot",
    status: "completed",
    contentItems: [{ type: "inputText", text: "/tmp/screen.png\nThumbnail /tmp/thumb.png" }],
  };
  assert.equal(toolProgressText(shotItem, true)?.includes("/tmp/screen.png"), true);
  assert.equal(toolProgressText(shotItem, true)?.includes("/tmp/thumb.png"), true);
  const deniedItem = {
    type: "dynamicToolCall",
    id: "d1",
    namespace: "host",
    tool: "host_shell",
    status: "failed",
    contentItems: [{ type: "inputText", text: "Denied" }],
  };
  assert.equal(toolProgressText(deniedItem, true), "Denied");
  const sandItem = {
    type: "dynamicToolCall",
    id: "sand-1",
    namespace: "sand",
    tool: "Shell",
    status: "completed",
    contentItems: [{ type: "inputText", text: "secret-output" }],
  };
  assert.notEqual(toolProgressText(sandItem, true), "secret-output");
  const rendered = renderStep(shellItem);
  assert.equal(rendered?.includes("host-tool-ok"), true);
  assert.equal(rendered?.includes("exit 0"), true);
  mark("host-rows");
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(".openbot-build/host-tool-local-exec-e2e.json", JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  closeBackgroundShells();
  await rm(root, { recursive: true, force: true });
}
