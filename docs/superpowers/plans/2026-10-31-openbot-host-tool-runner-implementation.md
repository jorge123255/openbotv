# OpenBot host-tool runner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship host Shell, screenshot, file actions, and host MCP for every OpenBot agent, behind Auto-review, with results on the chat tool row.

**Architecture:** One runner owns each host call. A provider tool call and a Grok local-exec frame both become one `HostToolRequest`. Auto-review runs in this OpenBot. Shell, screenshot, and file actions run on the selected machine. Host MCP runs in the OpenBot MCP client on this computer. The Grok sand turn stays on `POST /api/sendPrompt`. Sand rows from #37 stay display rows.

**Tech Stack:** Effect 4.0.0, existing `grok-bot` gateway session, `@modelcontextprotocol/sdk` `Client`, `McpGateway.forAgent`, `ScreenCaptureHost`, `@openbot/i18n` `sourceText`, Vitest for the two checks the design allows, E2E scripts under `scripts/`.

## Global Constraints

- Fork only. Do not open a pull request against `nightly-labs/openbot`.
- Phases 2, 3, and 4 ship in one implementation pull request. Phase 1 is #37. Do not implement it again.
- Every OpenBot agent can call host tools. There is no `grokBotHostTools` flag.
- Auto-review modes are `ask`, `always`, and `never`. The default is `ask`. There is no default of `always`.
- The Grok production turn is `POST /api/sendPrompt`. `directInference` stays off in `src/backend/provider-drivers.ts`.
- Local-exec paths stay `GET /local-exec/requests` and `POST /local-exec/responses`. Do not add a third HTTP path.
- Local-exec uses the gateway bearer and the stored gateway headers, including `x-anyrun-network-token` when it is present. Do not send the user sand access token.
- The checksum id in `openbot-grok-bot-machine-id` is not the host-tool target.
- MCP secrets stay on this computer. Do not call BotAI `loadServers`.
- Device, upload, and download frames are refused before Auto-review. They never match `always`.
- No SQLite migration. No Team API field. Do not change `AgentApprovalKind`.
- Redact tokens on every log, export, and send path. Do not put screenshot bytes on those paths.
- The renderer does not call the gateway. The main process keeps the local-exec tokens.
- New user-visible text uses `@openbot/i18n`. Main-process and backend errors use `sourceText`.
- The denied row uses a catalog key whose English source is `Denied`.
- Ask deadline is 10 minutes (`10 * 60 * 1000`), the same value as `gatewayTurnTimeoutMs` in `src/backend/grok-bot/grok-bot-agent-client.ts`.
- PolyForm Noncommercial 1.0.0 stays. Do not add a dependency.
- George set the E2E-only test default aside for two checks only: the policy gate, and the local-exec request and response shape. Those two checks are Vitest files. Every other check is an E2E script that writes a report under `.openbot-build/`.
- One test worker. Do not run `bun run typecheck` or a full suite. Run `bun run typecheck:node` after backend edits.

## Evidence used for field names

BotAI commit `63cc1e03586b07f5216b900f9e9f296ba0fddea7`. OpenBot `origin/main` at `a691a19b9`. The design spec wins when the 2026-10-30 analysis disagrees.

Decoded. Do not add fields that this list does not name.

| Source | Shape |
| --- | --- |
| `source/shared/gateway-wire.ts` | `GATEWAY_AUTH_SCHEME` is `Bearer`. `GATEWAY_NETWORK_TOKEN_HEADER` is `x-anyrun-network-token`. |
| `source/shared/local-exec-gateway.ts` | `GET` path `/local-exec/requests`. `POST` path `/local-exec/responses`. |
| `source/host/local-exec/local-exec-provider.ts` | Request kinds: `welcome`, `retire-approval`, `exec`, `upload`, `download`, `device`, `cancel`. Response kinds: `hello`, `ping`, `client`, `control`, `file`, `file-error`, `device-result`. POST JSON is `{ providerId, batchId?, frames }`. SSE blocks split on `\n\n`. Only `data:` lines are parsed. `computerId` is `hostname().trim()`, or `this-computer` when that string is empty. `label` is the hostname, or `this computer`. |
| `source/host/extensions/local-exec/local-exec-bridge.ts` | `LocalExecComputer` is `{ id, label, connected }`. `listComputers()` returns that array. `id` is the hello `computerId`. |
| `source/packages/proto/generated/agent/v1/exec_pb.ts` | Exec oneof cases used here: `shellArgs`, `shellStreamArgs`, `backgroundShellSpawnArgs`, `piBashArgs`, `miniSweAgentBashArgs`, `writeArgs`, `readArgs`, `redactedReadArgs`, `lsArgs`, `writeShellStdinArgs`, `computerUseArgs`, `mcpArgs`. |
| `ShellArgs` | `command`, `workingDirectory`, `timeout`, `toolCallId`. |
| `ShellSuccess` | `command`, `workingDirectory`, `exitCode`, `signal`, `stdout`, `stderr`, `executionTime`. |
| `WriteArgs` | `path`, `fileText`. `WriteSuccess` is `path`, `linesCreated`, `fileSize`. |
| `ReadArgs` | `path`, `offset`, `limit`. `ReadSuccess.output` case `content` is the text. |
| `LsArgs` | `path`. `LsSuccess.directoryTreeRoot` has `absPath`, `childrenFiles[].name`, `childrenDirs`, `childrenWereProcessed`, `numFiles`. |
| `WriteShellStdinArgs` | `chars` (`describeLocalExec`). |
| `ComputerUseArgs` | Nested `action.case`. The screenshot case is `screenshot` (`src/backend/grok-bot/grok-bot-box-computer.ts`). Success value fields used by that port: `actionCount`, `durationMs`, `screenshot`. |
| `McpArgs` | `name`, `args`, `toolCallId`, `providerIdentifier`, `toolName`, `serverIdentifier`. `McpSuccess.content[]` item `text.text`. |
| Device request | `request.operation` is `status`, `frame`, `input`, `messages`, `contacts`, or `chrome-cookies`. This ship refuses the frame. It does not read `args`. |
| OpenBot gateway session | `src/backend/grok-bot/grok-bot-gateway.ts` `postSession` sends `Authorization: Bearer ${session.token}` and `session.headers`. |
| OpenBot tool row | `dynamicToolCall` in `src/backend/grok-bot/grok-bot-agent-client.ts`. Sand rows use `namespace: "sand"`. Visible step text is `toolProgressText` in `src/backend/agent/thread-items.ts`. |
| MCP selection | `McpGateway.forAgent` in `src/backend/agent/mcp-gateway.ts`. `McpServerConfig` has `id`, `name`, `transport`, `command`, `args`, `url`. |
| Screen capture | `ScreenCaptureHost.capture` in `src/backend/agent/screen-capture.ts`. Thumbnail resize uses `nativeImage` in `src/main/application-services.ts`. |

`ShellArgs` has no `machineId`. The machine id is `LocalExecComputer.id`. A forum report of the model tool uses the word `machineId` and a `{ machines: [] }` body. The decoder accepts `id` or `machineId` on each item, and accepts either a bare array or `{ machines: [] }`. It does not read any other machine field.

Remote machines: the gateway routes an exec frame to the daemon that sent `hello.computerId`. This OpenBot is that daemon for this computer. There is no submit route under `src/backend/grok-bot/`. When `machineId` is not this computer's id, the row says the machine is unavailable. Do not invent an HTTP path. Record that gap in `host-tool-machines.ts`.

## Shipping

One branch. One pull request. One commit per task below. Do not open one pull request per phase.

The implementation changelog is `changelog.d/<branch>.md` in the last task. This plan document is not that changelog.

## File map

| File | Responsibility |
| --- | --- |
| Create `src/backend/host-tools/host-tool-policy.ts` | Per-user Auto-review document. Modes, ask deadline, retire-approval. |
| Create `src/backend/host-tools/host-tool-policy.test.ts` | Policy unit tests. The design allows this file. |
| Create `src/backend/host-tools/local-exec-frames.ts` | Frame kinds, machine list decode, header builder, exec-case mapping. |
| Create `src/backend/host-tools/local-exec-frames.test.ts` | Request and response shape unit tests. The design allows this file. |
| Create `src/backend/host-tools/host-tool-types.ts` | `HostToolRequest`, `HostToolRow`, action names. |
| Create `src/backend/host-tools/host-tool-machines.ts` | This computer's id. `selectMachine`. Remote gap. |
| Create `src/backend/host-tools/host-tool-executor.ts` | Shell, screenshot files, read, list, write, send-input on this computer. |
| Create `src/backend/host-tools/local-exec-client.ts` | SSE subscribe and response POST. No retry loop. |
| Create `src/backend/host-tools/host-tool-runner.ts` | Queue, refuse, gate, dispatch, row text. |
| Create `src/backend/host-tools/host-mcp.ts` | `McpGateway.forAgent` plus MCP `Client.callTool`. |
| Modify `src/backend/openbot-tools.ts` | Catalog entries for the host tools. |
| Modify `src/backend/agent/openbot-tool-router.ts` | Route those names into the runner. |
| Modify `src/backend/grok-bot/grok-bot-agent-client.ts` | Start local-exec inside `#viaGateway`. Leave `#projectSandTools` as display only. |
| Modify `src/backend/provider-drivers.ts` | Pass the runner into `GrokBotAgentClient`. Do not set `directInference`. |
| Modify `src/backend/agent/thread-items.ts` | Host-row progress text. |
| Modify `src/backend/agent/handoff-tool-steps.ts` | Host-row handoff text. |
| Modify `packages/i18n/src/messages/en/error/backend.ts` | Error sentences. |
| Modify `packages/i18n/src/messages/en/prompt.ts` | Allow once, Always, Never. |
| Modify `packages/contracts/src/ipc-endpoints.ts` | Desktop ask and answer channels. |
| Modify `packages/contracts/src/ipc-desktop-api` consumers | Preload bridge and `mock-openbot.ts`, as `packages/contracts/AGENTS.md` requires. |
| Create `src/main/ipc/host-tool-handlers.ts` | Ask event and answer request. |
| Create `packages/ui/src/features/conversation/HostToolApprovalCard.tsx` | Three choices. Do not reuse `ApprovalCard` `onAlwaysAllow`. |
| Create `scripts/host-tool-local-exec-e2e.ts` | Fake gateway, shell, offline, screenshot deny. |
| Create `scripts/host-tool-mcp-e2e.ts` | Selected server, empty selection, other agent. |
| Create `scripts/host-tool-smoke-e2e.ts` | Allow once, `echo host-tool-ok`, screenshot path, `directInference` off. |
| Create `changelog.d/<implementation-branch>.md` | User-visible note for host tool rows. |

Do not modify `src/backend/grok-bot/grok-bot-transcript.ts` except to leave sand parsing as it is. Do not modify `src/backend/grok-bot/grok-bot-box-exec.ts` or `grok-bot-box-computer.ts`. Those files are the sand box computer (#45).

---

### Task 1: Auto-review policy gate

**Files:**
- Create: `src/backend/host-tools/host-tool-policy.ts`
- Create: `src/backend/host-tools/host-tool-policy.test.ts`
- Modify: `packages/i18n/src/messages/en/error/backend.ts`

**Interfaces:**
- Consumes: nothing from later tasks
- Produces:
  - `HOST_TOOL_ACTIONS`, `HostToolAction`, `HostToolMode`
  - `HOST_TOOL_ASK_DEADLINE_MS` = `600_000`
  - `HostToolPolicy.decide(action)` → `"ask" | "always" | "never"`
  - `HostToolPolicy.allowOnce(action)`, `allowAlways(action, approvalId)`, `denyForever(action)`, `retireApproval(approvalId)`
  - `loadHostToolPolicy(path)` / `HostToolPolicy.save()`
  - `sourceText("error.backend.hostToolDenied")` English `Denied`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceText } from "@openbot/i18n/source";
import { HostToolPolicy, loadHostToolPolicy } from "./host-tool-policy";

describe("host tool policy", () => {
  it("asks when no rule matches and does not record a run", async () => {
    const policy = new HostToolPolicy();
    expect(policy.decide("shell")).toBe("ask");
    expect(policy.ran).toEqual([]);
  });

  it("runs always without a card and keeps the mode", async () => {
    const policy = new HostToolPolicy();
    policy.allowAlways("shell", "ap-1");
    expect(policy.decide("shell")).toBe("always");
    expect(policy.decide("screenshot")).toBe("ask");
  });

  it("denies never without a run", () => {
    const policy = new HostToolPolicy();
    policy.denyForever("shell");
    expect(policy.decide("shell")).toBe("never");
    expect(sourceText("error.backend.hostToolDenied")).toBe("Denied");
  });

  it("clears always on retire-approval and leaves never", () => {
    const policy = new HostToolPolicy();
    policy.allowAlways("shell", "ap-1");
    policy.denyForever("screenshot");
    policy.retireApproval("ap-1");
    expect(policy.decide("shell")).toBe("ask");
    expect(policy.decide("screenshot")).toBe("never");
    policy.retireApproval("missing");
    expect(policy.decide("screenshot")).toBe("never");
  });

  it("allow once does not change the stored mode", () => {
    const policy = new HostToolPolicy();
    policy.allowOnce("shell");
    expect(policy.decide("shell")).toBe("ask");
  });

  it("round-trips the document", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "host-tool-policy-"));
    const file = path.join(dir, "host-tool-review.json");
    const policy = await loadHostToolPolicy(file);
    policy.allowAlways("mcp", "ap-9");
    policy.denyForever("write-file");
    await policy.save();
    const again = await loadHostToolPolicy(file);
    expect(again.decide("mcp")).toBe("always");
    expect(again.decide("write-file")).toBe("never");
    const raw = await readFile(file, "utf8");
    expect(raw.includes("token")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:desktop -- --maxWorkers=1 src/backend/host-tools/host-tool-policy.test.ts`

Expected: FAIL. The module `./host-tool-policy` is missing.

- [ ] **Step 3: Write the implementation**

Add the key to `packages/i18n/src/messages/en/error/backend.ts` inside the existing `defineMessages("error.backend", { ... })` object:

```ts
"error.backend.hostToolDenied": "Denied",
"error.backend.hostToolRefused": "Refused",
"error.backend.hostToolMachineUnavailable": "The machine is unavailable.",
"error.backend.hostToolMachineOffline": "The machine is offline.",
"error.backend.hostToolScreenCaptureDenied": "The screen capture was denied.",
```

Create `src/backend/host-tools/host-tool-policy.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const HOST_TOOL_ACTIONS = [
  "shell",
  "screenshot",
  "read-file",
  "list-directory",
  "write-file",
  "send-input",
  "mcp",
] as const;
export type HostToolAction = (typeof HOST_TOOL_ACTIONS)[number];
export type HostToolMode = "ask" | "always" | "never";
export const HOST_TOOL_ASK_DEADLINE_MS = 10 * 60 * 1000;

interface PolicyDocument {
  rules: Partial<Record<HostToolAction, HostToolMode>>;
  approvals: Record<string, HostToolAction>;
}

function emptyDocument(): PolicyDocument {
  return { rules: {}, approvals: {} };
}

function isAction(value: unknown): value is HostToolAction {
  return typeof value === "string" && (HOST_TOOL_ACTIONS as readonly string[]).includes(value);
}

function isMode(value: unknown): value is HostToolMode {
  return value === "ask" || value === "always" || value === "never";
}

export class HostToolPolicy {
  /** Actions this object was asked to run. Tests use it. Production does not log it. */
  readonly ran: HostToolAction[] = [];
  #document: PolicyDocument;
  readonly #file: string | null;

  constructor(document: PolicyDocument = emptyDocument(), file: string | null = null) {
    this.#document = document;
    this.#file = file;
  }

  decide(action: HostToolAction): HostToolMode {
    return this.#document.rules[action] ?? "ask";
  }

  allowOnce(action: HostToolAction): void {
    this.ran.push(action);
  }

  allowAlways(action: HostToolAction, approvalId: string): void {
    this.#document.rules[action] = "always";
    this.#document.approvals[approvalId] = action;
    this.ran.push(action);
  }

  denyForever(action: HostToolAction): void {
    this.#document.rules[action] = "never";
  }

  retireApproval(approvalId: string): void {
    const action = this.#document.approvals[approvalId];
    delete this.#document.approvals[approvalId];
    if (action !== undefined && this.#document.rules[action] === "always") {
      delete this.#document.rules[action];
    }
  }

  async save(): Promise<void> {
    if (this.#file === null) return;
    await mkdir(path.dirname(this.#file), { recursive: true });
    await writeFile(this.#file, `${JSON.stringify(this.#document)}\n`, "utf8");
  }
}

export async function loadHostToolPolicy(file: string): Promise<HostToolPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return new HostToolPolicy(emptyDocument(), file);
  }
  const document = emptyDocument();
  if (typeof parsed === "object" && parsed !== null) {
    const body = parsed as { rules?: unknown; approvals?: unknown };
    if (typeof body.rules === "object" && body.rules !== null) {
      for (const [key, value] of Object.entries(body.rules)) {
        if (isAction(key) && isMode(value)) document.rules[key] = value;
      }
    }
    if (typeof body.approvals === "object" && body.approvals !== null) {
      for (const [key, value] of Object.entries(body.approvals)) {
        if (isAction(value)) document.approvals[key] = value;
      }
    }
  }
  return new HostToolPolicy(document, file);
}
```

The policy file is `join(userDataPath, "host-tool-review.json")`. Callers pass that path. Do not write it from SQLite.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:desktop -- --maxWorkers=1 src/backend/host-tools/host-tool-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/host-tools/host-tool-policy.ts src/backend/host-tools/host-tool-policy.test.ts packages/i18n/src/messages/en/error/backend.ts
git add src/backend/host-tools/host-tool-policy.ts src/backend/host-tools/host-tool-policy.test.ts packages/i18n/src/messages/en/error/backend.ts
git commit -m "feat: add the host-tool Auto-review policy"
```

---

### Task 2: Local-exec frame and machine-list shape

**Files:**
- Create: `src/backend/host-tools/host-tool-types.ts`
- Create: `src/backend/host-tools/local-exec-frames.ts`
- Create: `src/backend/host-tools/local-exec-frames.test.ts`

**Interfaces:**
- Consumes: `HostToolAction` from Task 1
- Produces:
  - `HostToolRequest`, `ListedMachine`, `selectMachine`
  - `localExecHeaders(session)` 
  - `decodeRequestFrame(value)`, `responsePostBody(providerId, frames, batchId?)`
  - `hostRequestFromExec(requestId, serverMessage, machineId?)`
  - `shellResultMessage`, `readResultMessage`, `LOCAL_EXEC_REQUESTS_PATH`, `LOCAL_EXEC_RESPONSES_PATH`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  LOCAL_EXEC_REQUESTS_PATH,
  LOCAL_EXEC_RESPONSES_PATH,
  decodeListedMachines,
  decodeRequestFrame,
  hostRequestFromExec,
  localExecHeaders,
  responsePostBody,
  selectMachine,
} from "./local-exec-frames";

const session = {
  token: "gateway-bearer",
  headers: { "x-anyrun-network-token": "net-1" },
  accessToken: "user-sand-access-token",
};

describe("local-exec frames", () => {
  it("reads requests on GET /local-exec/requests", () => {
    expect(LOCAL_EXEC_REQUESTS_PATH).toBe("/local-exec/requests");
    expect(LOCAL_EXEC_RESPONSES_PATH).toBe("/local-exec/responses");
  });

  it("sends the gateway bearer and omits the user sand access token", () => {
    const headers = localExecHeaders(session);
    expect(headers.authorization).toBe("Bearer gateway-bearer");
    expect(headers["x-anyrun-network-token"]).toBe("net-1");
    expect(JSON.stringify(headers).includes("user-sand-access-token")).toBe(false);
    expect(JSON.stringify(headers).includes("accessToken")).toBe(false);
  });

  it("carries machineId and one request id on shell and screenshot", () => {
    const shell = hostRequestFromExec("req-1", {
      message: { case: "shellStreamArgs", value: { command: "echo host-tool-ok", workingDirectory: "/tmp" } },
    }, "mac-1");
    expect(shell).toMatchObject({ id: "req-1", action: "shell", machineId: "mac-1", command: "echo host-tool-ok" });
    const shot = hostRequestFromExec("req-2", {
      message: { case: "computerUseArgs", value: { actions: [{ action: { case: "screenshot" } }] } },
    }, "mac-1");
    expect(shot).toMatchObject({ id: "req-2", action: "screenshot", machineId: "mac-1" });
  });

  it("repeats the request id on the response post", () => {
    const body = responsePostBody("prov-1", [
      { kind: "client", requestId: "req-1", message: { shellResult: { success: { stdout: "ok", exitCode: 0 } } } },
    ]);
    expect(body.providerId).toBe("prov-1");
    expect(body.frames[0]).toMatchObject({ requestId: "req-1" });
  });

  it("decodes listComputers ids and a machines wrapper", () => {
    expect(decodeListedMachines([{ id: "mac-1", label: "Mac", connected: true }])).toEqual([
      { id: "mac-1", label: "Mac", connected: true },
    ]);
    expect(decodeListedMachines({ machines: [{ machineId: "mac-2", connected: true }] })).toEqual([
      { id: "mac-2", label: "", connected: true },
    ]);
  });

  it("uses the only connected machine and refuses an unknown id", () => {
    const machines = [{ id: "mac-1", label: "Mac", connected: true }];
    expect(selectMachine(machines, undefined)).toEqual({ ok: true, machine: machines[0] });
    expect(selectMachine(machines, "other")).toEqual({ ok: false, code: "unavailable" });
    expect(selectMachine([
      { id: "a", label: "A", connected: true },
      { id: "b", label: "B", connected: true },
    ], undefined)).toEqual({ ok: false, code: "unavailable" });
    expect(selectMachine([], "mac-1")).toEqual({ ok: false, code: "unavailable" });
  });

  it("decodes device, upload, and download frames for the runner to refuse", () => {
    expect(decodeRequestFrame({ kind: "device", requestId: "d1", request: { operation: "chrome-cookies" } })?.kind).toBe("device");
    expect(decodeRequestFrame({ kind: "upload", requestId: "u1", path: "/tmp/a", bytesBase64: "YQ==" })?.kind).toBe("upload");
    expect(decodeRequestFrame({ kind: "download", requestId: "n1", path: "/tmp/a" })?.kind).toBe("download");
    expect(hostRequestFromExec("d1", { message: { case: "mcpArgs", value: {} } })).toMatchObject({ action: "mcp", id: "d1" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:desktop -- --maxWorkers=1 src/backend/host-tools/local-exec-frames.test.ts`

Expected: FAIL. The module is missing.

- [ ] **Step 3: Write the implementation**

Create `src/backend/host-tools/host-tool-types.ts`:

```ts
import type { HostToolAction } from "./host-tool-policy";

export interface HostToolRequest {
  readonly id: string;
  readonly action: HostToolAction;
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly machineId?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly isBackground?: boolean;
  readonly path?: string;
  readonly fileText?: string;
  readonly chars?: string;
  readonly shellId?: number;
  readonly serverIdentifier?: string;
  readonly providerIdentifier?: string;
  readonly toolName?: string;
  readonly arguments?: Record<string, unknown>;
}

export interface ListedMachine {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface HostToolRow {
  readonly id: string;
  readonly action: HostToolAction;
  readonly status: "completed" | "failed";
  readonly text: string;
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly path?: string;
  readonly thumbnailPath?: string;
}
```

Create `src/backend/host-tools/local-exec-frames.ts`:

```ts
import type { HostToolAction } from "./host-tool-policy";
import type { HostToolRequest, ListedMachine } from "./host-tool-types";

export const LOCAL_EXEC_REQUESTS_PATH = "/local-exec/requests";
export const LOCAL_EXEC_RESPONSES_PATH = "/local-exec/responses";
export const DEFAULT_COMPUTER_ID = "this-computer";

export interface GatewayHeaderSession {
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function localExecHeaders(session: GatewayHeaderSession): Record<string, string> {
  const headers: Record<string, string> = { ...session.headers };
  headers.authorization = `Bearer ${session.token}`;
  return headers;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type LocalExecRequestFrame =
  | { readonly kind: "welcome"; readonly providerId: string }
  | { readonly kind: "retire-approval"; readonly approvalId: string }
  | { readonly kind: "exec"; readonly requestId: string; readonly approvalId?: string; readonly serverMessage: Json }
  | { readonly kind: "upload"; readonly requestId: string; readonly path: string; readonly bytesBase64: string }
  | { readonly kind: "download"; readonly requestId: string; readonly path: string }
  | { readonly kind: "device"; readonly requestId: string; readonly request: Json }
  | { readonly kind: "cancel"; readonly requestId: string };

export type LocalExecResponseFrame =
  | { readonly kind: "hello"; readonly localRoot: string; readonly terminalsFolder: string; readonly computerId: string; readonly label: string }
  | { readonly kind: "ping" }
  | { readonly kind: "client" | "control"; readonly requestId: string; readonly message: Json }
  | { readonly kind: "file"; readonly requestId: string }
  | { readonly kind: "file-error"; readonly requestId: string; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeRequestFrame(value: unknown): LocalExecRequestFrame | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "welcome" && typeof value.providerId === "string") return { kind: "welcome", providerId: value.providerId };
  if (value.kind === "retire-approval" && typeof value.approvalId === "string") {
    return { kind: "retire-approval", approvalId: value.approvalId };
  }
  if (value.kind === "cancel" && typeof value.requestId === "string") return { kind: "cancel", requestId: value.requestId };
  if (typeof value.requestId !== "string") return null;
  if (value.kind === "exec") return { kind: "exec", requestId: value.requestId, serverMessage: (value.serverMessage ?? null) as Json };
  if (value.kind === "upload" && typeof value.path === "string" && typeof value.bytesBase64 === "string") {
    return { kind: "upload", requestId: value.requestId, path: value.path, bytesBase64: value.bytesBase64 };
  }
  if (value.kind === "download" && typeof value.path === "string") {
    return { kind: "download", requestId: value.requestId, path: value.path };
  }
  if (value.kind === "device") return { kind: "device", requestId: value.requestId, request: (value.request ?? null) as Json };
  return null;
}

export function responsePostBody(
  providerId: string | undefined,
  frames: readonly LocalExecResponseFrame[],
  batchId?: string,
): { providerId?: string; batchId?: string; frames: readonly LocalExecResponseFrame[] } {
  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(batchId === undefined ? {} : { batchId }),
    frames,
  };
}

const SHELL_CASES = new Set([
  "shellArgs",
  "shellStreamArgs",
  "backgroundShellSpawnArgs",
  "piBashArgs",
  "miniSweAgentBashArgs",
  "shell_args",
  "shell_stream_args",
  "background_shell_spawn_args",
  "pi_bash_args",
  "mini_swe_agent_bash_args",
]);

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function screenshotOnly(value: Record<string, unknown>): boolean {
  const actions = value.actions;
  if (!Array.isArray(actions) || actions.length === 0) return false;
  return actions.every((entry) => {
    if (!isRecord(entry)) return false;
    const action = isRecord(entry.action) ? entry.action : entry;
    return action.case === "screenshot" || action.screenshot != null;
  });
}

export function hostRequestFromExec(
  requestId: string,
  serverMessage: unknown,
  machineId?: string,
): HostToolRequest | null {
  const root = isRecord(serverMessage) ? serverMessage : {};
  const message = isRecord(root.message) ? root.message : root;
  const name = typeof message.case === "string" ? message.case : undefined;
  const value = isRecord(message.value) ? message.value : message;
  const base = {
    id: requestId,
    agentId: "",
    threadId: "",
    turnId: "",
    ...(machineId === undefined ? {} : { machineId }),
  };
  if (name !== undefined && SHELL_CASES.has(name)) {
    const command = stringField(value, "command");
    if (command === undefined) return null;
    return {
      ...base,
      action: "shell",
      command,
      ...(value.isBackground === true || value.is_background === true ? { isBackground: true } : {}),
      ...(stringField(value, "workingDirectory", "working_directory") === undefined
        ? {}
        : { workingDirectory: stringField(value, "workingDirectory", "working_directory") }),
    };
  }
  if (name === "writeArgs" || name === "write_args") {
    const filePath = stringField(value, "path");
    if (filePath === undefined) return null;
    return { ...base, action: "write-file", path: filePath, fileText: stringField(value, "fileText", "file_text") ?? "" };
  }
  if (name === "readArgs" || name === "redactedReadArgs" || name === "read_args" || name === "redacted_read_args") {
    const filePath = stringField(value, "path");
    if (filePath === undefined) return null;
    return { ...base, action: "read-file", path: filePath };
  }
  if (name === "lsArgs" || name === "ls_args") {
    const filePath = stringField(value, "path");
    if (filePath === undefined) return null;
    return { ...base, action: "list-directory", path: filePath };
  }
  if (name === "writeShellStdinArgs" || name === "write_shell_stdin_args") {
    const shellId = value.shellId;
    return {
      ...base,
      action: "send-input",
      chars: stringField(value, "chars") ?? "",
      ...(typeof shellId === "number" ? { shellId } : {}),
    };
  }
  if ((name === "computerUseArgs" || name === "computer_use_args") && screenshotOnly(value)) {
    return { ...base, action: "screenshot" };
  }
  if (name === "mcpArgs" || name === "mcp_args") {
    return {
      ...base,
      action: "mcp",
      ...(stringField(value, "serverIdentifier", "server_identifier") === undefined
        ? {}
        : { serverIdentifier: stringField(value, "serverIdentifier", "server_identifier") }),
      ...(stringField(value, "providerIdentifier", "provider_identifier") === undefined
        ? {}
        : { providerIdentifier: stringField(value, "providerIdentifier", "provider_identifier") }),
      toolName: stringField(value, "toolName", "tool_name") ?? stringField(value, "name") ?? "",
      ...(isRecord(value.args) ? { arguments: value.args as Record<string, unknown> } : {}),
    };
  }
  return null;
}

export function decodeListedMachines(body: unknown): ListedMachine[] {
  const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.machines) ? body.machines : [];
  const machines: ListedMachine[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = stringField(row, "id", "machineId");
    if (id === undefined || id.length === 0) continue;
    machines.push({
      id,
      label: stringField(row, "label") ?? "",
      connected: row.connected === true,
    });
  }
  return machines;
}

export function selectMachine(
  machines: readonly ListedMachine[],
  machineId: string | undefined,
): { ok: true; machine: ListedMachine } | { ok: false; code: "unavailable" } {
  const connected = machines.filter((machine) => machine.connected);
  if (machineId !== undefined) {
    const found = connected.find((machine) => machine.id === machineId);
    return found === undefined ? { ok: false, code: "unavailable" } : { ok: true, machine: found };
  }
  if (connected.length === 1) return { ok: true, machine: connected[0] };
  return { ok: false, code: "unavailable" };
}

export function shellResultMessage(command: string, workingDirectory: string, exitCode: number, stdout: string, stderr: string): Json {
  return {
    shellResult: {
      success: { command, workingDirectory, exitCode, signal: "", stdout, stderr, executionTime: 0 },
    },
  };
}

export function readResultMessage(filePath: string, content: string): Json {
  return { readResult: { success: { path: filePath, content, totalLines: content.split("\n").length, truncated: false } } };
}

export function refusedControlMessage(requestId: string, error: string): LocalExecResponseFrame {
  return { kind: "control", requestId, message: { throw: { error } } };
}

export type { HostToolAction };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:desktop -- --maxWorkers=1 src/backend/host-tools/local-exec-frames.test.ts`

Expected: PASS. Then run the policy file again. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/host-tools/host-tool-types.ts src/backend/host-tools/local-exec-frames.ts src/backend/host-tools/local-exec-frames.test.ts
git add src/backend/host-tools/host-tool-types.ts src/backend/host-tools/local-exec-frames.ts src/backend/host-tools/local-exec-frames.test.ts
git commit -m "feat: decode host-tool local-exec frames"
```

---

### Task 3: This computer's executor

**Files:**
- Create: `src/backend/host-tools/host-tool-machines.ts`
- Create: `src/backend/host-tools/host-tool-executor.ts`
- Create: `scripts/host-tool-local-exec-e2e.ts`

**Interfaces:**
- Consumes: `HostToolRequest`, `shellResultMessage`, `readResultMessage`, `DEFAULT_COMPUTER_ID`
- Produces:
  - `thisComputer(hostname: string): ListedMachine`
  - `executeHostAction(request, deps)` → `{ message, rowText, stdout?, exitCode?, path?, thumbnailPath? }`
  - `containPath(root, target)`

The remote gap is a comment and a branch in `thisComputer`: the directory this process can address is that one id.

- [ ] **Step 1: Write the failing E2E**

Create `scripts/host-tool-local-exec-e2e.ts` that imports `executeHostAction` and `thisComputer`. The script writes `.openbot-build/host-tool-local-exec-e2e.json`.

Assert all of the following in that script with `node:assert/strict`:

1. `thisComputer("Mac")` equals `{ id: "Mac", label: "Mac", connected: true }`.
2. `thisComputer("  ")` equals `{ id: "this-computer", label: "this computer", connected: true }`.
3. A shell request `{ id: "s1", action: "shell", command: "echo host-tool-ok", agentId: "a", threadId: "t", turnId: "u" }` with a runner that returns `{ code: 0, stdout: "host-tool-ok\n", stderr: "" }` yields `exitCode` 0, `stdout` `host-tool-ok\n`, and a client message `shellResult.success.exitCode` of 0.
4. A screenshot request whose capture returns `{ denied: true }` yields `text` equal to `sourceText("error.backend.hostToolScreenCaptureDenied")` and does not set `path`.
5. A screenshot request whose capture returns `{ png: Buffer.from([1, 2, 3]) }` and whose thumbnail returns the same bytes writes two files. The result `path` and `thumbnailPath` both exist. The result text includes both paths. `JSON.stringify(result.message)` does not include a base64 image.
6. `executeHostAction` for `machineId` `"other-mac"` returns the unavailable sentence and does not call the runner.
7. A read of a file inside the root returns `readResult.success.content`. A path outside the root returns `readResult.error` and does not read the file.
8. A shell request with `isBackground: true` stays open. A later `send-input` request with that `shellId` and `chars: "hi"` writes those chars to the process. An unknown `shellId` does not spawn a process and the row text is `The machine is unavailable.`

Run command at the bottom of the script:

```ts
await mkdir(".openbot-build", { recursive: true });
await writeFile(".openbot-build/host-tool-local-exec-e2e.json", JSON.stringify({ ok: true, checks }, null, 2));
```

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL. `executeHostAction` is not exported.

- [ ] **Step 3: Write the implementation**

`src/backend/host-tools/host-tool-machines.ts`:

```ts
import { hostname } from "node:os";
import { DEFAULT_COMPUTER_ID } from "./local-exec-frames";
import type { ListedMachine } from "./host-tool-types";

/**
 * This process is the local-exec daemon for one computer.
 * BotAI addresses another computer by routing to the subscriber that sent that
 * computerId. OpenBot has no second submit route. A different id stays unavailable.
 */
export function thisComputer(host = hostname()): ListedMachine {
  const trimmed = host.trim();
  if (trimmed.length === 0) return { id: DEFAULT_COMPUTER_ID, label: "this computer", connected: true };
  return { id: trimmed, label: trimmed, connected: true };
}
```

`src/backend/host-tools/host-tool-executor.ts` exports `containPath` and `executeHostAction`.

`containPath` resolves the target under `root`. It throws when `path.relative(root, resolved)` starts with `..` or is absolute. That is the rule in BotAI `containPath`.

`executeHostAction` signature:

```ts
export interface HostCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostCaptureResult {
  readonly png: Uint8Array;
  readonly thumbnailPng: Uint8Array;
}

export interface HostExecutorDeps {
  readonly root: string;
  readonly computer: ListedMachine;
  readonly run: (command: string, cwd: string) => Promise<HostCommandResult>;
  readonly capture: () => Promise<HostCaptureResult | { readonly denied: true }>;
  readonly writeShot: (png: Uint8Array, thumbnail: Uint8Array) => Promise<{ path: string; thumbnailPath: string }>;
}

export async function executeHostAction(
  request: HostToolRequest,
  deps: HostExecutorDeps,
): Promise<{
  ok: boolean;
  text: string;
  message: unknown;
  stdout?: string;
  exitCode?: number;
  path?: string;
  thumbnailPath?: string;
}>
```

Behavior:

- When `request.machineId` is set and it is not `deps.computer.id`, return `ok: false`, `text` from `sourceText("error.backend.hostToolMachineUnavailable")`, and do not call `run` or `capture`.
- `shell`: call `deps.run(command, workingDirectory || root)`. Build `shellResultMessage`. `text` is `${stdout.trimEnd()}\n${sourceText("status.agent.hostToolExit", { code: String(code) })}`. Add the status key in `packages/i18n/src/messages/en/status/agent.ts`: `"status.agent.hostToolExit": "exit {code}"`. Add `"status.agent.hostToolThumbnail": "Thumbnail {path}"` in the same file.
- `screenshot` denied: `text` is `sourceText("error.backend.hostToolScreenCaptureDenied")`. `message` is `{ computerUseResult: { error: { error: text } } }`.
- `screenshot` allowed: `writeShot`, then `message` is `{ computerUseResult: { success: { actionCount: 1, durationMs: 0, screenshot: path } } }`. `screenshot` is the path string. Do not put the png bytes in `message`.
- `read-file` and `list-directory`: `containPath` first. Read or `readdir`. List message:

```ts
{
  lsResult: {
    success: {
      directoryTreeRoot: {
        absPath: resolved,
        childrenFiles: names.filter(isFile).map((name) => ({ name })),
        childrenDirs: names.filter(isDir).map((name) => ({ absPath: join(resolved, name), childrenFiles: [], childrenDirs: [], childrenWereProcessed: false, numFiles: 0 })),
        childrenWereProcessed: true,
        numFiles: fileCount,
      },
    },
  },
}
```

Row text is the file names, one per line.

- `write-file`: `containPath`, write `fileText` as utf8, message `{ writeResult: { success: { path, linesCreated, fileSize } } }`.
- `send-input`: `hostRequestFromExec` reads `chars` and numeric `shellId` from `writeShellStdinArgs`. The executor keeps a map of shell processes it started. A shell request with `isBackground: true` stays in that map under the next integer id and the row text includes that id. `send-input` writes `chars` to that process stdin when the id is in the map. When the id is missing, the row text is `sourceText("error.backend.hostToolMachineUnavailable")` and stdin is not written. The E2E starts one background shell, sends `chars`, and asserts the process received those chars. An unknown `shellId` does not spawn a process.
- `mcp`: throw. Task 7 owns MCP. The executor returns unavailable for `mcp` so a mis-routed call does not start a server.

- [ ] **Step 4: Run the script to verify it passes**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0 and `.openbot-build/host-tool-local-exec-e2e.json` with `"ok": true`.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/host-tools/host-tool-machines.ts src/backend/host-tools/host-tool-executor.ts scripts/host-tool-local-exec-e2e.ts packages/i18n/src/messages/en/status/agent.ts
git add src/backend/host-tools/host-tool-machines.ts src/backend/host-tools/host-tool-executor.ts scripts/host-tool-local-exec-e2e.ts packages/i18n/src/messages/en/status/agent.ts
git commit -m "feat: run host shell and screenshot on this computer"
```

---

### Task 4: Local-exec SSE client

**Files:**
- Create: `src/backend/host-tools/local-exec-client.ts`
- Modify: `scripts/host-tool-local-exec-e2e.ts`

**Interfaces:**
- Consumes: `localExecHeaders`, `decodeRequestFrame`, `responsePostBody`, `LOCAL_EXEC_REQUESTS_PATH`, `LOCAL_EXEC_RESPONSES_PATH`
- Produces: `runLocalExecClient(options): Promise<void>`

```ts
export interface LocalExecClientOptions {
  readonly baseUrl: string;
  readonly session: GatewayHeaderSession;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly onFrame: (frame: LocalExecRequestFrame) => Promise<LocalExecResponseFrame | null>;
  readonly hello: () => LocalExecResponseFrame;
}
```

- [ ] **Step 1: Extend the E2E with a fake gateway**

Add a loopback HTTP server to `scripts/host-tool-local-exec-e2e.ts`:

- `GET /local-exec/requests` returns `200` and `text/event-stream`. The body is one SSE block: `data: {"kind":"welcome","providerId":"prov-1"}\n\n` then `data: {"kind":"exec","requestId":"req-9","serverMessage":{"message":{"case":"shellStreamArgs","value":{"command":"echo host-tool-ok"}}}}\n\n`.
- `POST /local-exec/responses` stores the JSON body.
- A second `GET` while the first is open returns `409` and closes.
- Assert the first client posts `hello` with `computerId` from `thisComputer()`, then a `client` frame whose `requestId` is `req-9`.
- Assert the request headers are `authorization: Bearer gateway-bearer` and `x-anyrun-network-token: net-1`.
- Assert the header block does not contain `user-sand-access-token`.
- Start a second `runLocalExecClient` against the same server. Assert it rejects. Assert the first response listener is still the one that received `req-9`.
- Assert the client function returns after `signal.abort()` and does not open a third GET.

- [ ] **Step 2: Run the script to verify the new checks fail**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL on missing `runLocalExecClient`.

- [ ] **Step 3: Write the client**

`runLocalExecClient`:

1. `GET` `${baseUrl}/local-exec/requests` with `localExecHeaders(session)` plus `accept: text/event-stream`.
2. When `response.ok` is false or `response.body` is null, throw `sourceText("error.backend.hostToolMachineOffline")`. Do not loop.
3. POST `hello` once, then read the body. Split on `\n\n`. Parse `data:` lines with `decodeRequestFrame`.
4. `welcome` stores `providerId` and posts no disk IO.
5. `retire-approval` calls `options.onFrame` and posts nothing else.
6. `exec` calls `onFrame`. POST the returned frame with `responsePostBody(providerId, [frame])`.
7. `upload`, `download`, and `device` call `onFrame` so the runner can refuse them. POST that refusal. Do not write the upload bytes.
8. On `signal.abort()`, cancel the reader and return.
9. A thrown subscribe error propagates. The function does not schedule another GET.

Use `fetchImpl` when it is set, otherwise `fetch`.

- [ ] **Step 4: Run the script to verify it passes**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/host-tools/local-exec-client.ts scripts/host-tool-local-exec-e2e.ts
git add src/backend/host-tools/local-exec-client.ts scripts/host-tool-local-exec-e2e.ts
git commit -m "feat: subscribe to the host local-exec channel"
```

---

### Task 5: Runner queue, refuse path, and ask deadline

**Files:**
- Create: `src/backend/host-tools/host-tool-runner.ts`
- Modify: `scripts/host-tool-local-exec-e2e.ts`

**Interfaces:**
- Consumes: `HostToolPolicy`, `executeHostAction`, `hostRequestFromExec`, `selectMachine`, `refusedControlMessage`, `HOST_TOOL_ASK_DEADLINE_MS`
- Produces:

```ts
export interface HostToolRunnerDeps {
  readonly policy: HostToolPolicy;
  readonly computer: ListedMachine;
  readonly execute: HostExecutorDeps;
  readonly now: () => number;
  readonly ask: (request: HostToolRequest) => Promise<"allow-once" | "always" | "never" | "expired">;
  readonly emitRow: (row: HostToolRow) => void;
}

export async function handleLocalExecFrame(
  frame: LocalExecRequestFrame,
  deps: HostToolRunnerDeps,
  context: { agentId: string; threadId: string; turnId: string },
): Promise<LocalExecResponseFrame | null>
```

- [ ] **Step 1: Extend the E2E**

Add these cases to the script. Each one calls `handleLocalExecFrame` and reads `emitRow`:

| Frame | Policy | Expected row text | Executor calls |
| --- | --- | --- | --- |
| `device` operation `messages` | `always` for `shell` | `Refused` | 0 |
| `upload` | `always` for `write-file` | `Refused` | 0 |
| `download` | `always` for `read-file` | `Refused` | 0 |
| shell exec | no rule, ask returns `allow-once` | stdout and `exit 0` | 1 |
| shell exec | `always` | stdout | 1, and `ask` is not called |
| shell exec | `never` | `Denied` | 0 |
| shell exec | ask returns `never` | `Denied`, and the next `decide("shell")` is `never` | 0 |
| shell exec | ask returns `expired` | `Denied` | 0 |
| shell exec | `retire-approval` then shell | the second shell calls `ask` | 1 then ask |
| shell exec with `machineId` `other` | `always` | `The machine is unavailable.` | 0 |
| client GET returns 409 |  | `The machine is offline.` from the thrown `runLocalExecClient` error | 0 |

`ask` must not be called for the device frame. Assert `policy.decide("shell")` is still `always` after the device frame.

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL. `handleLocalExecFrame` is missing.

- [ ] **Step 3: Write the runner**

Order inside `handleLocalExecFrame`:

1. `welcome` returns null. The client already stored `providerId`.
2. `cancel` returns null.
3. `retire-approval` calls `policy.retireApproval(frame.approvalId)` and `policy.save()`. Returns null.
4. `device`, `upload`, and `download` emit a failed row with `sourceText("error.backend.hostToolRefused")` and return `refusedControlMessage` for `device` and `exec`-shaped ids, or `{ kind: "file-error", requestId, error }` for upload and download. Do not call `policy.decide`.
5. `exec`: `hostRequestFromExec`. When it returns null, emit `Refused` and return a control throw. Fill `agentId`, `threadId`, and `turnId` from `context`.
6. `selectMachine([deps.computer], request.machineId)`. On failure, emit the unavailable sentence. Do not call `execute`.
7. `policy.decide(action)`.
   - `never`: emit `Denied`. Do not execute.
   - `always`: execute.
   - `ask`: call `deps.ask`. Race it with a timer of `HOST_TOOL_ASK_DEADLINE_MS` using `deps.now` if the ask promise does not resolve. `expired` and `never` emit `Denied`. `never` also calls `denyForever` and `save`. `allow-once` calls `allowOnce` then executes. `always` calls `allowAlways(action, frame.approvalId ?? request.id)` and `save`, then executes.
8. Execution errors from a missing daemon path use the offline sentence. `capture` denied uses the screen-capture sentence.
9. Emit one `HostToolRow`. Return the response frame from the executor message wrapped as `{ kind: "client", requestId, message }`.

Do not retry.

- [ ] **Step 4: Run the script to verify it passes**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/host-tools/host-tool-runner.ts scripts/host-tool-local-exec-e2e.ts
git add src/backend/host-tools/host-tool-runner.ts scripts/host-tool-local-exec-e2e.ts
git commit -m "feat: gate host-tool calls before they run"
```

---

### Task 6: Ask card on the desktop IPC boundary

**Files:**
- Modify: `packages/i18n/src/messages/en/prompt.ts`
- Modify: `packages/contracts/src/ipc-endpoints.ts`
- Create: `packages/contracts/src/ipc-host-tools.ts`
- Create: `src/main/ipc/host-tool-handlers.ts`
- Modify: `src/main/index.ts` (`registerIpcGroups` entry only)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/preview/mock-openbot.ts`
- Create: `packages/ui/src/features/conversation/HostToolApprovalCard.tsx`
- Modify: the conversation view that already renders `ApprovalCard` (`packages/ui/src/features/conversation/threads/AgentThreadView.tsx`) to render the new card when a host-tool ask is in the props

**Interfaces:**
- Consumes: `HostToolAction`
- Produces:
  - `IPC_ENDPOINTS.hostTools.answer` request channel `host-tools:answer`
  - `IPC_ENDPOINTS.hostTools.ask` event channel `host-tools:ask`
  - `HostToolApprovalCard` props `{ actionLabel, detail, pending, onAllowOnce, onAlways, onNever }`

Do not add a value to `AgentApprovalKind`. Do not change `ApprovalCard`.

- [ ] **Step 1: Write the failing E2E for the answer decode**

The IPC payload crosses the trust boundary. Add the decode checks to `scripts/host-tool-local-exec-e2e.ts` by importing the decoder (no Electron):

```ts
export function decodeHostToolAnswer(value: unknown): { requestId: string; decision: "allow-once" | "always" | "never" } | null
```

Assert:

- `{ requestId: "r1", decision: "allow-once" }` decodes.
- `{ requestId: "r1", decision: "accept" }` returns null. `accept` is the command-approval word. It is not a host-tool decision.
- A payload with `gatewayToken` returns null.
- A payload with `accessToken` returns null.

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL. The decoder is missing.

- [ ] **Step 3: Write the card, the contract, and the handler**

Prompt keys inside `defineMessages("prompt", ...)`:

```ts
"prompt.hostTool.label": "Host tool approval",
"prompt.hostTool.allowOnce": "Allow once",
"prompt.hostTool.always": "Always",
"prompt.hostTool.never": "Never",
```

`packages/contracts/src/ipc-host-tools.ts` holds `HostToolAsk` and `HostToolAnswer` plus `decodeHostToolAnswer`. `HostToolAsk` fields are `requestId`, `agentId`, `threadId`, `turnId`, `action`, `detail`. No token field.

Add group `hostTools` to `IPC_ENDPOINTS` and `IPC_GROUP_PATHS` (`hostTools: "hostTools"`). Follow `request` and `event` in `ipc-endpoints.ts`.

`src/main/ipc/host-tool-handlers.ts` follows `src/main/ipc/AGENTS.md`: a dependencies object, handlers keyed by endpoint name, `payloadHandler` plus the decoder. The sender check stays in `define-ipc-group.ts`. The handler resolves the pending ask. It does not read gateway tokens.

`HostToolApprovalCard` uses `useText()` from `@openbot/ui/text`. Buttons call the three callbacks. The component does not import the renderer or `window.openbot`.

Wire the card in `AgentThreadView.tsx` beside the existing `ApprovalCard`. Pass the ask through a new optional prop. Leave the existing approval props as they are.

Preload: `bridgeGroup(IPC_ENDPOINTS.hostTools, { answer: decode, ask: decodeAsk })` and put it on the desktop API object at `hostTools`. Mirror the methods in `mock-openbot.ts` so the type `OpenBotDesktopApi` still holds. The mock stores one ask and resolves it when `answer` is called.

- [ ] **Step 4: Run checks**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0.

Run: `bun run typecheck:node`

Expected: exit 0. This sees `src/main`, `src/preload`, and `packages/contracts`.

Run: `bun run typecheck:renderer`

Expected: exit 0. Run it after `typecheck:node`, not in parallel.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none packages/contracts/src/ipc-host-tools.ts packages/contracts/src/ipc-endpoints.ts src/main/ipc/host-tool-handlers.ts src/main/index.ts src/preload/index.ts src/renderer/src/preview/mock-openbot.ts packages/ui/src/features/conversation/HostToolApprovalCard.tsx packages/ui/src/features/conversation/threads/AgentThreadView.tsx packages/i18n/src/messages/en/prompt.ts scripts/host-tool-local-exec-e2e.ts
git add packages/contracts/src/ipc-host-tools.ts packages/contracts/src/ipc-endpoints.ts src/main/ipc/host-tool-handlers.ts src/main/index.ts src/preload/index.ts src/renderer/src/preview/mock-openbot.ts packages/ui/src/features/conversation/HostToolApprovalCard.tsx packages/ui/src/features/conversation/threads/AgentThreadView.tsx packages/i18n/src/messages/en/prompt.ts scripts/host-tool-local-exec-e2e.ts
git commit -m "feat: ask before a host tool runs"
```

---

### Task 7: Tool adapter for every provider

**Files:**
- Modify: `src/backend/openbot-tools.ts`
- Modify: `src/backend/agent/openbot-tool-router.ts`
- Modify: `scripts/host-tool-local-exec-e2e.ts`

**Interfaces:**
- Consumes: `handleLocalExecFrame` is not used here. Add `runHostToolRequest(request, deps): Promise<HostToolRow>` in `host-tool-runner.ts` that takes a `HostToolRequest` and uses the same decide, select, and execute path as step 6–9 of Task 5.
- Produces: catalog tools `host_shell`, `host_screenshot`, `host_read_file`, `host_list_directory`, `host_write_file`, `host_send_input`, `host_list_machines`.

`host_mcp` is Task 8. Do not register it in this task.

- [ ] **Step 1: Extend the E2E**

Call the pure mapper `hostToolRequestFromCatalog(tool, args, context)`:

| Tool | Args | Request |
| --- | --- | --- |
| `host_shell` | `{ command: "echo host-tool-ok", machineId: "Mac" }` | `action: "shell"`, `command`, `machineId: "Mac"` |
| `host_screenshot` | `{}` | `action: "screenshot"`, no `machineId` |
| `host_read_file` | `{ path: "notes.txt" }` | `action: "read-file"` |
| `host_list_directory` | `{ path: "." }` | `action: "list-directory"` |
| `host_write_file` | `{ path: "a.txt", fileText: "hi" }` | `action: "write-file"`, `fileText: "hi"` |
| `host_send_input` | `{ chars: "y" }` | `action: "send-input"` |
| `host_list_machines` | `{}` | returns the `thisComputer()` list as text, and does not call `execute` |

Assert a tool name `capture_screen` returns null from the mapper. That tool stays on `#screenCaptureTool`.

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL. The mapper is missing.

- [ ] **Step 3: Write the catalog entries and the router branch**

In `src/backend/openbot-tools.ts`, add definitions next to `capture_screen`. Shapes use `zod` the same way as `captureScreenToolShape`. Names and fields:

```ts
{ name: "host_shell", shape: { command: z.string().min(1), machineId: z.string().min(1).optional(), workingDirectory: z.string().optional() } }
{ name: "host_screenshot", shape: { machineId: z.string().min(1).optional() } }
{ name: "host_read_file", shape: { path: z.string().min(1), machineId: z.string().min(1).optional() } }
{ name: "host_list_directory", shape: { path: z.string().min(1), machineId: z.string().min(1).optional() } }
{ name: "host_write_file", shape: { path: z.string().min(1), fileText: z.string(), machineId: z.string().min(1).optional() } }
{ name: "host_send_input", shape: { chars: z.string(), machineId: z.string().min(1).optional() } }
{ name: "host_list_machines", shape: {} }
```

Descriptions say the tool runs on a registered machine after Auto-review. They name `host_list_machines` as the source of `machineId`. They say a screenshot is the screen of that machine.

Do not add these names to `DIRECT_NAMES` in `src/backend/agent/tool-catalog.ts`. They stay in `BUILTIN_TOOL_CATALOG` and are reached with `tool_search` and `tool_call`, the same way as `capture_screen`.

In `OpenBotToolRouter`, after the `capture_screen` branch, handle the seven names. Build a `HostToolRequest` with `id` from the tool request id. Call `runHostToolRequest`. `client.respond` with `{ success: row.status === "completed", contentItems: [{ type: "inputText", text: row.text }] }`.

`host_list_machines` responds with the JSON of `[thisComputer()]` and does not call the executor.

Pass the policy path `join(userDataPath, "host-tool-review.json")` from the router options. Add the dependency on the router options object that already receives `userData` or the database path. Read `OpenBotToolRouterOptions` and thread the directory through the existing constructor. Do not open a new database.

- [ ] **Step 4: Run the script and the node typecheck**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0.

Run: `bun run typecheck:node`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/openbot-tools.ts src/backend/agent/openbot-tool-router.ts src/backend/host-tools/host-tool-runner.ts scripts/host-tool-local-exec-e2e.ts
git add src/backend/openbot-tools.ts src/backend/agent/openbot-tool-router.ts src/backend/host-tools/host-tool-runner.ts scripts/host-tool-local-exec-e2e.ts
git commit -m "feat: offer host tools to every agent"
```

---

### Task 8: Host MCP

**Files:**
- Create: `src/backend/host-tools/host-mcp.ts`
- Modify: `src/backend/openbot-tools.ts`
- Modify: `src/backend/agent/openbot-tool-router.ts`
- Create: `scripts/host-tool-mcp-e2e.ts`

**Interfaces:**
- Consumes: `McpGateway.forAgent`, `McpGateway.endpoint`, `McpServerConfig`, `Client` and `StreamableHTTPClientTransport` from the MCP SDK (the same pair `src/backend/mcp-probe.ts` uses)
- Produces: `runHostMcp(input): Promise<{ text: string } | { refused: true }>`

```ts
export async function runHostMcp(input: {
  readonly configs: readonly McpServerConfig[];
  readonly agentId: string;
  readonly forAgent: (configs: readonly McpServerConfig[], agentId: string) => McpServerConfig[];
  readonly serverIdentifier?: string;
  readonly providerIdentifier?: string;
  readonly toolName: string;
  readonly arguments?: Record<string, unknown>;
  readonly call: (config: McpServerConfig, toolName: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<{ text: string } | { refused: true }>
```

- [ ] **Step 1: Write the failing E2E**

`scripts/host-tool-mcp-e2e.ts` uses a fake `forAgent` that returns the configs whose `id` is in the agent's `mcpServerIds`. When `mcpServerIds` is undefined, it returns every config. When the agent id is unknown, it returns `[]`. That matches `McpGateway.forAgent`.

Cases:

1. Agent `a` selected server `srv`. `runHostMcp` with `serverIdentifier: "srv"` and `toolName: "ping"` calls `call` once and returns `{ text: "pong" }`.
2. Agent `a` with `mcpServerIds: []` returns `{ refused: true }` and does not call `call`.
3. Agent `b` does not own `srv`. `forAgent` returns `[]` for that config. Result is `{ refused: true }`. `call` is not used.
4. `mcpArgs` mapped by `hostRequestFromExec` then `runHostMcp` returns the text. The response message is `{ mcpResult: { success: { content: [{ text: { text: "pong" } }], isError: false } } }`.
5. The script writes `.openbot-build/host-tool-mcp-e2e.json`.

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-mcp-e2e.ts`

Expected: FAIL. `runHostMcp` is missing.

- [ ] **Step 3: Write the MCP host**

`runHostMcp`:

- `const selected = input.forAgent(input.configs, input.agentId)`.
- When `selected.length === 0`, return `{ refused: true }`.
- Match `serverIdentifier` to `config.id`. If that misses, match `providerIdentifier` or `serverIdentifier` to `config.name`.
- When no row matches, return `{ refused: true }`.
- Call `input.call(config, toolName, arguments ?? {})`.
- Do not read another agent's list. The filter is the only list.

Production `call` in the router:

- `yield* gateway.endpoint(config, agentId)`.
- On `McpEndpointRefusal`, return refused.
- HTTP: `new Client({ name: "openbot-host-tool", version: "1" })` and `new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.authorization ? { authorization: `Bearer ${endpoint.authorization}` } : {} } })`.
- stdio: `StdioClientTransport` with `config.command`, `config.args`, and `cwd` when `config.workingDirectory` is non-empty. This is the same pair of transports `mcp-probe.ts` constructs. Do not copy server config to a sand body.
- `client.callTool({ name: toolName, arguments: args })`. Join `content` items whose `type` is `text`.
- Close the client in a `finally` block.
- Empty selection returns before `new Client`.

Add `host_mcp` to `openbot-tools.ts`:

```ts
shape: {
  serverIdentifier: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
}
```

The router branch calls `runHostMcp` and then `runHostToolRequest` only for the policy gate. MCP does not use `machineId`. On `{ refused: true }`, the row text is `sourceText("error.backend.hostToolRefused")` and the server `call` is not reached.

Wire `mcpArgs` in `handleLocalExecFrame` to this function. Post `{ kind: "client", requestId, message: { mcpResult: { success: { content: [{ text: { text } }], isError: false } } } }`.

- [ ] **Step 4: Run the script**

Run: `bun scripts/host-tool-mcp-e2e.ts`

Expected: exit 0.

Run: `bun scripts/agent-mcp-scope-e2e.ts`

Expected: exit 0. Agent MCP scope must stay as it is.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/host-tools/host-mcp.ts src/backend/host-tools/host-tool-runner.ts src/backend/openbot-tools.ts src/backend/agent/openbot-tool-router.ts scripts/host-tool-mcp-e2e.ts
git add src/backend/host-tools/host-mcp.ts src/backend/host-tools/host-tool-runner.ts src/backend/openbot-tools.ts src/backend/agent/openbot-tool-router.ts scripts/host-tool-mcp-e2e.ts
git commit -m "feat: run host MCP on this computer"
```

---

### Task 9: Grok gateway attachment

**Files:**
- Modify: `src/backend/grok-bot/grok-bot-agent-client.ts`
- Modify: `src/backend/provider-drivers.ts`
- Modify: `scripts/host-tool-local-exec-e2e.ts`

**Interfaces:**
- Consumes: `runLocalExecClient`, `handleLocalExecFrame`, `thisComputer`
- Produces: `GrokBotAgentClient` option `hostTools?: { handle(frame, context): Promise<LocalExecResponseFrame | null> }`

- [ ] **Step 1: Extend the E2E**

Read `src/backend/provider-drivers.ts` as text. Assert the `id: "grok-bot"` `createClient` block does not contain `directInference`.

Assert `#viaGateway` still calls `sendGrokBotPrompt`. A comment or a source read of `grok-bot-agent-client.ts` shows `sendGrokBotPrompt` remains, and `namespace: "sand"` remains in `#emitSandTool`.

Add a fake session `{ url, token: "gateway-bearer", headers: { "x-anyrun-network-token": "net-1" } }` and assert a helper `grokLocalExecHeaders(session)` returns `localExecHeaders` of that session. Pass a sibling `accessToken` on the object and assert the returned headers omit it.

- [ ] **Step 2: Run the script to verify the new helper fails**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL until `grokLocalExecHeaders` exists. The source assertions can pass before the helper does. Keep them in the same script.

- [ ] **Step 3: Attach the client**

In `GrokBotAgentClient` options, add the optional `hostTools` handler. In `#viaGateway`, after the gateway session loads and before `sendGrokBotPrompt`:

- When `hostTools` is absent, do not open `/local-exec/requests`.
- When it is present and `session` is non-null, start `runLocalExecClient` with `baseUrl: session.url`, headers from `grokLocalExecHeaders(session)`, and `signal` from the turn abort controller.
- `onFrame` calls `hostTools.handle(frame, { agentId: thread.id, threadId: thread.id, turnId: turn.id })`.
- In the existing `finally`, abort that client.
- Do not call `#runTool` from this path.
- Do not change `#projectSandTools`.
- While a host-tool ask is unresolved, treat the turn the same way `activity.permissionPending` does: `quietOpen` stays true, so the quiet timer does not complete the turn. Expose `pendingAsks()` on the runner. The poll loop reads it. The turn ends after Allow once, Always, Never, expiry, or the existing 10 minute turn limit.

`grokLocalExecHeaders` takes the gateway session type from `grok-bot-gateway.ts` (`token` and `headers` only). It calls `localExecHeaders`. It has no parameter for the account access token.

In `provider-drivers.ts` `createClient` and `createProfileClient` for `grok-bot`, pass `hostTools` when the driver context has a runner. Do not add `directInference: true`.

The driver context needs a `hostToolRunner` optional field next to `grokBotAccount`. Thread it from the main process service that owns `userDataPath` and `ScreenCaptureHost`. The capture callback uses `nativeImage.createFromBuffer(Buffer.from(png)).resize({ width: 320 }).toPNG()` for the thumbnail, the same `resize` call `application-services.ts` already uses. When capture throws `ScreenCaptureFailed`, pass `{ denied: true }`.

- [ ] **Step 4: Run the scripts**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0.

Run: `bun scripts/grok-bot-agent-turn-e2e.ts`

Expected: exit 0. That script still sets `directInference: true` on its own client. Production `provider-drivers.ts` stays without the flag.

Run: `bun run typecheck:node`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/grok-bot/grok-bot-agent-client.ts src/backend/provider-drivers.ts src/main/application-services.ts scripts/host-tool-local-exec-e2e.ts
git add src/backend/grok-bot/grok-bot-agent-client.ts src/backend/provider-drivers.ts src/main/application-services.ts scripts/host-tool-local-exec-e2e.ts
git commit -m "feat: attach host tools to the Grok gateway turn"
```

If `application-services.ts` is not the construction site, put the capture adapter in the file that already constructs `GrokBotAgentClient`'s context. Do not construct it inside the renderer.

---

### Task 10: Tool row text

**Files:**
- Modify: `src/backend/agent/thread-items.ts`
- Modify: `src/backend/agent/handoff-tool-steps.ts`
- Modify: `scripts/host-tool-local-exec-e2e.ts`

**Interfaces:**
- Consumes: `HostToolRow.text`, `namespace: "host"`
- Produces: `toolProgressText` and `renderStep` show that text for host rows

- [ ] **Step 1: Extend the E2E**

Build thread items and call the exported functions:

```ts
const shell = {
  type: "dynamicToolCall",
  id: "s1",
  namespace: "host",
  tool: "host_shell",
  status: "completed",
  contentItems: [{ type: "inputText", text: "host-tool-ok\nexit 0" }],
};
expect(toolProgressText(shell, true)).toBe("host-tool-ok\nexit 0");

const shot = {
  type: "dynamicToolCall",
  id: "p1",
  namespace: "host",
  tool: "host_screenshot",
  status: "completed",
  contentItems: [{ type: "inputText", text: "/tmp/screen.png\nThumbnail /tmp/thumb.png" }],
};
expect(toolProgressText(shot, true)).toContain("/tmp/screen.png");
expect(toolProgressText(shot, true)).toContain("/tmp/thumb.png");

const denied = {
  type: "dynamicToolCall",
  id: "d1",
  namespace: "host",
  tool: "host_shell",
  status: "failed",
  contentItems: [{ type: "inputText", text: "Denied" }],
};
expect(toolProgressText(denied, true)).toBe("Denied");

const sand = {
  type: "dynamicToolCall",
  id: "sand-1",
  namespace: "sand",
  tool: "Shell",
  status: "completed",
  contentItems: [{ type: "inputText", text: "secret-output" }],
};
expect(toolProgressText(sand, true)).not.toBe("secret-output");
```

Use the real `toolProgressText` return for a completed sand shell if it is the generic progress sentence. Assert it is not `secret-output`. That keeps sand rows as display rows with the existing progress line.

Assert `renderStep` for the host shell item contains `host-tool-ok` and `exit 0`.

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: FAIL. Host progress text is still the generic sentence.

- [ ] **Step 3: Show the host result**

In `toolProgressText`, before the generic descriptor tests, when `getString(item, "namespace") === "host"`:

- Read `contentItems`.
- Join `inputText` texts.
- Return that string when it is non-empty.
- Do not return image bytes. Ignore `inputImage`.

In `renderStep` for `dynamicToolCall`, when `namespace === "host"`, append the same joined text after the tool name. Keep the redaction call `field` already uses. Do not append `contentItems` for `namespace === "sand"`.

- [ ] **Step 4: Run the script**

Run: `bun scripts/host-tool-local-exec-e2e.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none src/backend/agent/thread-items.ts src/backend/agent/handoff-tool-steps.ts scripts/host-tool-local-exec-e2e.ts
git add src/backend/agent/thread-items.ts src/backend/agent/handoff-tool-steps.ts scripts/host-tool-local-exec-e2e.ts
git commit -m "feat: show host tool stdout and screenshots in the chat"
```

---

### Task 11: Approve-path smoke

**Files:**
- Create: `scripts/host-tool-smoke-e2e.ts`
- Create: `changelog.d/<implementation-branch>.md`

**Interfaces:**
- Consumes: `runHostToolRequest`, `HostToolPolicy`, `executeHostAction`, `thisComputer`, `toolProgressText`

- [ ] **Step 1: Write the failing smoke script**

`scripts/host-tool-smoke-e2e.ts`:

1. Policy file in a temp directory. `decide("shell")` is `ask`.
2. `ask` returns `allow-once`.
3. `run` is the real `echo host-tool-ok` through the executor's command runner (`spawn` with `shell: true` is acceptable for this one command because the script passes a fixed string).
4. Capture writes a PNG file under the temp directory and a thumbnail PNG. The row text contains both paths and `host-tool-ok` and `exit 0`.
5. `directInference` is absent from the `grok-bot` `createClient` block in `provider-drivers.ts`.
6. A second case feeds a failed subscribe error into the runner and expects `The machine is offline.`
7. A third case feeds `{ denied: true }` and expects `The screen capture was denied.`
8. The report path is `.openbot-build/host-tool-smoke-e2e.json` with `{ ok: true, echo: "host-tool-ok", exitCode: 0, directInference: false }`.
9. The script does not import `grok-bot-box-computer.ts` or `grok-bot-box-exec.ts`.

- [ ] **Step 2: Run the script to verify it fails**

Run: `bun scripts/host-tool-smoke-e2e.ts`

Expected: FAIL until the runner export used by the script is wired. If Task 5 already exported it, the script fails on a missing assertion instead. Fix the script until the first run fails for a missing behavior, then implement only that gap.

- [ ] **Step 3: Close the remaining gap**

If the runner already passes the script, the only new file is the script plus the changelog. The changelog file name uses the implementation branch, with `-` for `/`:

```md
### Added

- OpenBot agents can run a shell command and a screenshot on this computer after you allow it. The result shows in the chat.
```

- [ ] **Step 4: Run the smoke and the focused checks**

Run one at a time:

```bash
bun scripts/host-tool-smoke-e2e.ts
bun scripts/host-tool-local-exec-e2e.ts
bun scripts/host-tool-mcp-e2e.ts
bun run test:desktop -- --maxWorkers=1 src/backend/host-tools/host-tool-policy.test.ts
bun run test:desktop -- --maxWorkers=1 src/backend/host-tools/local-exec-frames.test.ts
bun run typecheck:node
```

Expected: each command exits 0.

Leave `bun run typecheck`, mobile typecheck, and the full test suite to CI.

- [ ] **Step 5: Commit**

```bash
biome check --write --max-diagnostics=none scripts/host-tool-smoke-e2e.ts changelog.d
git add scripts/host-tool-smoke-e2e.ts changelog.d/<implementation-branch>.md
git commit -m "feat: smoke host shell and screenshot"
```

## Self-review

| Design requirement | Task |
| --- | --- |
| Tool adapter for every provider | Task 7, catalog plus `OpenBotToolRouter` |
| Shell, screenshot, read, list, write, send-input | Tasks 3 and 7 |
| Auto-review `ask` / `always` / `never`, default `ask` | Task 1 |
| Allow once, Always, Never card | Task 6 |
| 10 minute expiry, turn stays open during the card, then continues, row `Denied` | Tasks 5 and 9 |
| `retire-approval` clears `always` and leaves `never` | Tasks 1 and 5 |
| Device frame does not match `always` | Task 5 |
| Upload and download refused | Task 5 |
| `GET /local-exec/requests`, `POST /local-exec/responses`, same request id | Task 2 |
| No user sand access token | Tasks 2 and 4 |
| Second subscriber disconnects, no retry loop | Task 4 |
| `machineId` from `listComputers` `id` | Tasks 2 and 3 |
| Unknown, empty, or ambiguous machine | Task 2 `selectMachine` |
| Remote machine gap, no new HTTP path | Task 3 `thisComputer` |
| Offline daemon | Tasks 4 and 11 |
| OS screenshot deny | Tasks 3 and 11 |
| Host MCP, empty selection, other agent | Task 8 |
| MCP result also on `POST /local-exec/responses` for `mcpArgs` | Task 8 |
| Sand rows stay `namespace: "sand"` and are not executed | Tasks 9 and 10 |
| `POST /api/sendPrompt`, `directInference` off | Task 9 and Task 11 |
| Row shows stdout, exit code, path, thumbnail, denial, error | Task 10 |
| i18n `Denied` | Task 1 |
| No SQLite migration, no Team API change | Task 6 uses a new desktop IPC group |
| #45 box computer untouched | File map |
| Phase 1 not reimplemented | File map |

Placeholder scan: this plan names every field from the evidence table. It does not leave a step for a later author to fill.

Type names stay `HostToolRequest`, `HostToolRow`, `ListedMachine`, `handleLocalExecFrame`, `runHostToolRequest`, `runHostMcp`, and `thisComputer` from the task that defines them through the task that uses them.
