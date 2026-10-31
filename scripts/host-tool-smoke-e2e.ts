// Approve-path smoke for host shell and screenshot on this computer.
// bun scripts/host-tool-smoke-e2e.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { runHostCommand } from "../src/backend/host-tools/host-tool-executor";
import { thisComputer } from "../src/backend/host-tools/host-tool-machines";
import { loadHostToolPolicy } from "../src/backend/host-tools/host-tool-policy";
import { runHostToolRequest } from "../src/backend/host-tools/host-tool-runner";
import { runLocalExecClient } from "../src/backend/host-tools/local-exec-client";

const dir = await mkdtemp(join(tmpdir(), "host-tool-smoke-"));
const policy = await loadHostToolPolicy(join(dir, "host-tool-review.json"));
assert.equal(policy.decide("shell"), "ask");
const computer = thisComputer();
const shell = await runHostToolRequest(
  {
    id: "echo",
    action: "shell",
    agentId: "a",
    threadId: "t",
    turnId: "u",
    command: "echo host-tool-ok",
  },
  {
    policy,
    computer,
    execute: {
      root: dir,
      computer,
      run: runHostCommand,
      capture: async () => ({ denied: true }),
      writeShot: async () => ({ path: "", thumbnailPath: "" }),
    },
    now: () => Date.now(),
    ask: async () => "allow-once",
    emitRow: () => undefined,
  },
);
assert.equal(shell.exitCode, 0);
assert.equal(shell.text.includes("host-tool-ok"), true);
assert.equal(shell.text.includes("exit 0"), true);

const screenPath = join(dir, "screen.png");
const thumbPath = join(dir, "thumb.png");
const png = Buffer.from([1, 2, 3]);
const shot = await runHostToolRequest(
  { id: "shot", action: "screenshot", agentId: "a", threadId: "t", turnId: "u" },
  {
    policy,
    computer,
    execute: {
      root: dir,
      computer,
      run: runHostCommand,
      capture: async () => ({ png, thumbnailPng: png }),
      writeShot: async (bytes, thumbnail) => {
        await writeFile(screenPath, bytes);
        await writeFile(thumbPath, thumbnail);
        return { path: screenPath, thumbnailPath: thumbPath };
      },
    },
    now: () => Date.now(),
    ask: async () => "allow-once",
    emitRow: () => undefined,
  },
);
assert.equal(shot.text.includes(screenPath), true);
assert.equal(shot.text.includes(thumbPath), true);

const drivers = readFileSync("src/backend/provider-drivers.ts", "utf8");
const grokStart = drivers.indexOf('id: "grok-bot"');
const grokBlock = drivers.slice(grokStart, drivers.indexOf('id: "acp"', grokStart));
assert.equal(grokBlock.includes("directInference"), false);

const server = createServer((_req, res) => {
  res.writeHead(409);
  res.end();
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("The fake gateway has no port.");
try {
  await assert.rejects(
    runLocalExecClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      session: { token: "gateway-bearer", headers: {} },
      signal: AbortSignal.timeout(2_000),
      hello: () => ({
        kind: "hello",
        localRoot: dir,
        terminalsFolder: dir,
        computerId: computer.id,
        label: computer.label,
      }),
      onFrame: async () => null,
    }),
    (error: unknown) => error instanceof Error && error.message === sourceText("error.backend.hostToolMachineOffline"),
  );
} finally {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

const denied = await runHostToolRequest(
  { id: "denied-shot", action: "screenshot", agentId: "a", threadId: "t", turnId: "u" },
  {
    policy,
    computer,
    execute: {
      root: dir,
      computer,
      run: runHostCommand,
      capture: async () => ({ denied: true }),
      writeShot: async () => ({ path: screenPath, thumbnailPath: thumbPath }),
    },
    now: () => Date.now(),
    ask: async () => "allow-once",
    emitRow: () => undefined,
  },
);
assert.equal(denied.text, sourceText("error.backend.hostToolScreenCaptureDenied"));

await mkdir(".openbot-build", { recursive: true });
await writeFile(
  ".openbot-build/host-tool-smoke-e2e.json",
  JSON.stringify({ ok: true, echo: "host-tool-ok", exitCode: 0, directInference: false }, null, 2),
);
