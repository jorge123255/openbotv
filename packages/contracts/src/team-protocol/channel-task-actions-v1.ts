// Frozen optional channel-task-actions-v1 wire contract. No released channel command changes.
import { isDynamicRecord, isString } from "../runtime-values";
import { CHANNEL_ROUTES, channelResponse } from "./channels-v1";
import type { TeamProtocolV2Json } from "./v2";

export const CHANNEL_TASK_ACTIONS_CAPABILITY = "channel-task-actions-v1";
export const CHANNEL_TASK_CANCEL_PATH = "/v1/channels/tasks/cancel";
export const CHANNEL_TASK_RECOVER_PATH = "/v1/channels/tasks/recover";

/** An exact task revision, confirmed by the reader, and an idempotent operation id. */
export function channelTaskCancelRequest(value: unknown): TeamProtocolV2Json {
  if (!isDynamicRecord(value)) throw new Error("Invalid channel cancellation request.");
  const identifier = (input: unknown): string => {
    if (!isString(input) || !input.length || input.length > 128)
      throw new Error("Invalid channel cancellation identifier.");
    return input;
  };
  const revision = value.expectedRevision;
  const channelRevision = value.expectedChannelRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Invalid channel cancellation revision.");
  if (typeof channelRevision !== "number" || !Number.isSafeInteger(channelRevision) || channelRevision < 0)
    throw new Error("Invalid channel cancellation channel revision.");
  return {
    channelId: identifier(value.channelId),
    taskId: identifier(value.taskId),
    operationId: identifier(value.operationId),
    expectedRevision: revision,
    expectedChannelRevision: channelRevision,
  };
}

export function channelTaskRecoverRequest(value: unknown): TeamProtocolV2Json {
  const common = channelTaskCancelRequest(value);
  if (
    !isDynamicRecord(common) ||
    !isDynamicRecord(value) ||
    (value.action !== "resume" && value.action !== "reassign") ||
    !(
      value.recipientAgentId === null ||
      (isString(value.recipientAgentId) && value.recipientAgentId.length > 0 && value.recipientAgentId.length <= 128)
    ) ||
    (value.action === "reassign" && value.recipientAgentId === null) ||
    (value.action === "resume" && value.recipientAgentId !== null)
  )
    throw new Error("Invalid reviewed channel task action.");
  return { ...common, action: value.action, recipientAgentId: value.recipientAgentId };
}

/** The result has the released channel shape; errors retain the released error envelope. */
export function channelTaskCancelResponse(_path: string, status: number, value: unknown): TeamProtocolV2Json {
  return channelResponse(CHANNEL_ROUTES.command, status, value);
}
