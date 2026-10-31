import type { McpServerConfig } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { mcpSuccessMessage, runHostMcp } from "./host-mcp";
import type { HostActionResult, HostExecutorDeps } from "./host-tool-executor";
import { executeHostAction } from "./host-tool-executor";
import type { HostToolPolicy } from "./host-tool-policy";
import { HOST_TOOL_ASK_DEADLINE_MS, type HostToolAction } from "./host-tool-policy";
import type { HostToolRequest, HostToolRow, ListedMachine } from "./host-tool-types";
import {
  hostRequestFromExec,
  type LocalExecRequestFrame,
  type LocalExecResponseFrame,
  refusedControlMessage,
  selectMachine,
  toJson,
} from "./local-exec-frames";

export interface HostToolRunnerDeps {
  readonly policy: HostToolPolicy;
  readonly computer: ListedMachine;
  readonly execute: HostExecutorDeps;
  readonly now: () => number;
  readonly ask: (request: HostToolRequest) => Promise<"allow-once" | "always" | "never" | "expired">;
  readonly emitRow: (row: HostToolRow) => void;
  readonly mcp?: {
    readonly configs: readonly McpServerConfig[];
    readonly forAgent: (configs: readonly McpServerConfig[], agentId: string) => McpServerConfig[];
    readonly call: (
      config: McpServerConfig,
      toolName: string,
      args: { readonly [key: string]: unknown },
    ) => Promise<string>;
  };
}

type AskDecision = "allow-once" | "always" | "never" | "expired";

let pendingAsks = 0;

/** Host-tool cards that are still open. A turn stays open while this is above zero. */
export function pendingHostToolAsks() {
  return pendingAsks;
}

/**
 * One local-exec frame. Device, upload, and download never reach Auto-review.
 * The function does not retry.
 */
/** The decide, select, and execute path for one host-tool request. */
export async function runHostToolRequest(request: HostToolRequest, deps: HostToolRunnerDeps): Promise<HostToolRow> {
  let row: HostToolRow | null = null;
  const wrapped: HostToolRunnerDeps = {
    ...deps,
    emitRow: (next) => {
      row = next;
      deps.emitRow(next);
    },
  };
  await gate({ kind: "exec", requestId: request.id, serverMessage: null }, request, wrapped);
  return (
    row ?? {
      id: request.id,
      action: request.action,
      status: "failed",
      text: sourceText("error.backend.hostToolRefused"),
    }
  );
}

export async function handleLocalExecFrame(
  frame: LocalExecRequestFrame,
  deps: HostToolRunnerDeps,
  context: { agentId: string; threadId: string; turnId: string },
): Promise<LocalExecResponseFrame | null> {
  if (frame.kind === "welcome" || frame.kind === "cancel") return null;
  if (frame.kind === "retire-approval") {
    deps.policy.retireApproval(frame.approvalId);
    await deps.policy.save();
    return null;
  }
  if (frame.kind === "device" || frame.kind === "upload" || frame.kind === "download") {
    return refuseFrame(frame, deps);
  }
  const mapped = hostRequestFromExec(frame.requestId, frame.serverMessage, frame.machineId);
  if (mapped === null) {
    const text = sourceText("error.backend.hostToolRefused");
    failed(deps, frame.requestId, "shell", text);
    return refusedControlMessage(frame.requestId, text);
  }
  const request: HostToolRequest = {
    ...mapped,
    agentId: context.agentId,
    threadId: context.threadId,
    turnId: context.turnId,
  };
  return gate(frame, request, deps);
}

function refuseFrame(
  frame: Extract<LocalExecRequestFrame, { kind: "device" | "upload" | "download" }>,
  deps: HostToolRunnerDeps,
): LocalExecResponseFrame {
  const text = sourceText("error.backend.hostToolRefused");
  const action: HostToolAction =
    frame.kind === "upload" ? "write-file" : frame.kind === "download" ? "read-file" : "shell";
  failed(deps, frame.requestId, action, text);
  if (frame.kind === "device") return refusedControlMessage(frame.requestId, text);
  return { kind: "file-error", requestId: frame.requestId, error: text };
}

async function gate(
  frame: Extract<LocalExecRequestFrame, { kind: "exec" }>,
  request: HostToolRequest,
  deps: HostToolRunnerDeps,
): Promise<LocalExecResponseFrame> {
  if (request.action !== "mcp") {
    const selected = selectMachine([deps.computer], request.machineId);
    if (!selected.ok) {
      const text = sourceText("error.backend.hostToolMachineUnavailable");
      failed(deps, request.id, request.action, text);
      return { kind: "client", requestId: request.id, message: { error: text } };
    }
  }
  const mode = deps.policy.decide(request.action);
  if (mode === "never") return denied(deps, request);
  if (mode === "ask") {
    const decision = await askWithDeadline(request, deps);
    if (decision === "expired") return denied(deps, request);
    if (decision === "never") {
      deps.policy.denyForever(request.action);
      await deps.policy.save();
      return denied(deps, request);
    }
    if (decision === "allow-once") deps.policy.allowOnce(request.action);
    if (decision === "always") {
      deps.policy.allowAlways(request.action, frame.approvalId ?? request.id);
      await deps.policy.save();
    }
  }
  if (request.action === "mcp") return performMcp(request, deps);
  return perform(request, deps);
}

async function performMcp(request: HostToolRequest, deps: HostToolRunnerDeps): Promise<LocalExecResponseFrame> {
  const mcp = deps.mcp;
  const toolName = request.toolName;
  if (mcp === undefined || toolName === undefined || toolName.length === 0) {
    return refusedMcp(request, deps);
  }
  try {
    const result = await runHostMcp({
      configs: mcp.configs,
      agentId: request.agentId,
      forAgent: mcp.forAgent,
      ...(request.serverIdentifier === undefined ? {} : { serverIdentifier: request.serverIdentifier }),
      ...(request.providerIdentifier === undefined ? {} : { providerIdentifier: request.providerIdentifier }),
      toolName,
      ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
      call: mcp.call,
    });
    if ("refused" in result) return refusedMcp(request, deps);
    deps.emitRow({ id: request.id, action: "mcp", status: "completed", text: result.text });
    return { kind: "client", requestId: request.id, message: mcpSuccessMessage(result.text) };
  } catch {
    return refusedMcp(request, deps);
  }
}

function refusedMcp(request: HostToolRequest, deps: HostToolRunnerDeps): LocalExecResponseFrame {
  const text = sourceText("error.backend.hostToolRefused");
  failed(deps, request.id, request.action, text);
  return { kind: "client", requestId: request.id, message: { throw: { error: text } } };
}

async function askWithDeadline(request: HostToolRequest, deps: HostToolRunnerDeps): Promise<AskDecision> {
  const started = deps.now();
  const remaining = HOST_TOOL_ASK_DEADLINE_MS - (deps.now() - started);
  pendingAsks += 1;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("expired"), Math.max(0, remaining));
      deps.ask(request).then(
        (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  } finally {
    pendingAsks -= 1;
  }
}

function denied(deps: HostToolRunnerDeps, request: HostToolRequest): LocalExecResponseFrame {
  const text = sourceText("error.backend.hostToolDenied");
  failed(deps, request.id, request.action, text);
  return { kind: "client", requestId: request.id, message: { error: text } };
}

async function perform(request: HostToolRequest, deps: HostToolRunnerDeps): Promise<LocalExecResponseFrame> {
  try {
    const result = await executeHostAction(request, deps.execute);
    deps.emitRow(rowFromResult(request, result));
    return { kind: "client", requestId: request.id, message: toJson(result.message) };
  } catch {
    const text = sourceText("error.backend.hostToolMachineOffline");
    failed(deps, request.id, request.action, text);
    return { kind: "client", requestId: request.id, message: { error: text } };
  }
}

function failed(deps: HostToolRunnerDeps, id: string, action: HostToolAction, text: string): void {
  deps.emitRow({ id, action, status: "failed", text });
}

function rowFromResult(request: HostToolRequest, result: HostActionResult): HostToolRow {
  return {
    id: request.id,
    action: request.action,
    status: result.ok ? "completed" : "failed",
    text: result.text,
    ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.path === undefined ? {} : { path: result.path }),
    ...(result.thumbnailPath === undefined ? {} : { thumbnailPath: result.thumbnailPath }),
  };
}
