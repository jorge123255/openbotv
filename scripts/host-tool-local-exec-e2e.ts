// Host shell, screenshot, and file actions on this computer.
// bun scripts/host-tool-local-exec-e2e.ts
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { closeBackgroundShells, executeHostAction } from "../src/backend/host-tools/host-tool-executor";
import { thisComputer } from "../src/backend/host-tools/host-tool-machines";
import type { HostToolRequest } from "../src/backend/host-tools/host-tool-types";

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
  await mkdir(".openbot-build", { recursive: true });
  await writeFile(".openbot-build/host-tool-local-exec-e2e.json", JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  closeBackgroundShells();
  await rm(root, { recursive: true, force: true });
}
