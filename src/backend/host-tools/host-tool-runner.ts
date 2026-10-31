import { sourceText } from "@openbot/i18n/source";
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
}

type AskDecision = "allow-once" | "always" | "never" | "expired";

/**
 * One local-exec frame. Device, upload, and download never reach Auto-review.
 * The function does not retry.
 */
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
  const selected = selectMachine([deps.computer], request.machineId);
  if (!selected.ok) {
    const text = sourceText("error.backend.hostToolMachineUnavailable");
    failed(deps, request.id, request.action, text);
    return { kind: "client", requestId: request.id, message: { error: text } };
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
  return perform(request, deps);
}

async function askWithDeadline(request: HostToolRequest, deps: HostToolRunnerDeps): Promise<AskDecision> {
  const started = deps.now();
  const remaining = HOST_TOOL_ASK_DEADLINE_MS - (deps.now() - started);
  return new Promise((resolve, reject) => {
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
