import { Schema } from "effect";

// Official hermes-agent@f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f:
// tui_gateway/contracts/{canonical,canonical_sessions,events}.py. Main-only, not IPC.
export class HermesChatFailure extends Schema.TaggedError<HermesChatFailure>()("HermesChatFailure", {
  code: Schema.Literals([
    "invalid-input",
    "unsupported-protocol",
    "not-connected",
    "profile-mismatch",
    "session-mismatch",
    "invalid-response",
    "transport",
    "timeout",
    "closed",
    "busy",
    "limit",
    "stale-prompt",
    "uncertain",
    "rpc-rejected",
  ]),
}) {}

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Text = Schema.String.check(Schema.isMaxLength(32_768));
const Choices = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(32));
export const ChatPrompt = Schema.Struct({
  kind: Schema.Literals(["approval", "clarify"]),
  prompt_id: Id,
  execution_generation: Natural,
  choices: Choices,
  command: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  question: Schema.optionalKey(Text),
  multi_select: Schema.optionalKey(Schema.Boolean),
  // Structured edit approvals need a dedicated review surface; null/absent only in this stage.
  edit: Schema.optionalKey(Schema.Null),
});
const Ref = Schema.Struct({ profile_id: Id, session_id: Id });
export const ChatReceipt = Schema.Struct({
  admission_id: Id,
  ref: Ref,
  sequence: Natural,
  status: Schema.Literals(["queued", "started", "unknown", "terminal"]),
  outcome: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  authority_epoch: Natural,
  execution_generation: Schema.NullOr(Natural),
});
export const ChatSnapshot = Schema.Struct({
  session_id: Id,
  running: Schema.Boolean,
  authority_epoch: Natural,
  replay_epoch: Id,
  last_sequence: Natural,
  execution_generation: Natural,
  pending: Schema.Array(
    Schema.Struct({
      ...ChatReceipt.fields,
      input_id: Id,
    }),
  ).check(Schema.isMaxLength(128)),
  prompts: Schema.Array(ChatPrompt).check(Schema.isMaxLength(32)),
  info: Schema.Struct({
    desktop_protocol: Schema.Literal("hermes-gateway-v1"),
    profile_id: Id,
    profile_name: Id,
  }),
});
const ChatSessionUpdate = Schema.Struct({
  desktop_protocol: Schema.Literal("hermes-gateway-v1"),
  authority_epoch: Natural,
  execution_generation: Natural,
  running: Schema.Boolean,
  pending: ChatSnapshot.fields.pending,
  profile_id: Schema.optionalKey(Id),
  profile_name: Schema.optionalKey(Id),
});
const ChatSessionMetadata = ChatSnapshot.fields.info;
type ChatSessionInfo =
  | { kind: "control"; value: typeof ChatSessionUpdate.Type }
  | { kind: "metadata"; value: typeof ChatSessionMetadata.Type };

/** The owner publishes both control state and local settings under session.info. Any control
 * field commits the payload to the full strict control schema; partial controls cannot fall back. */
export function decodeChatSessionInfo(value: unknown): ChatSessionInfo {
  const hasControlField =
    typeof value === "object" &&
    value !== null &&
    ["authority_epoch", "execution_generation", "running", "pending"].some((key) => Object.hasOwn(value, key));
  if (hasControlField) return { kind: "control", value: decodeChat(ChatSessionUpdate, value) };
  return { kind: "metadata", value: decodeChat(ChatSessionMetadata, value) };
}
export const ChatDescription = Schema.Struct({
  instance_id: Id,
  profile_id: Id,
  authority_epoch: Natural,
  capabilities: Schema.Array(Id).check(Schema.isMaxLength(64)),
});
export const ChatPromptResult = Schema.Struct({
  status: Schema.Literals(["resolved", "already_resolved"]),
  prompt_id: Id,
});
export const ChatHandle = Schema.Struct({
  ref: Ref,
  authority_epoch: Natural,
  execution_generation: Natural,
  execution_state: Schema.Literals(["idle", "running", "waiting", "unknown", "terminal"]),
});
export const ChatReady = Schema.Struct({ session_authority: Schema.Literal(true), heartbeat: Schema.Literal(true) });
export const ChatCapabilities = Schema.Struct({ server_requests: Schema.Array(Id).check(Schema.isMaxLength(128)) });
export const ChatFrame = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Int]))),
  method: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int })),
});
export const ChatEnvelope = Schema.Struct({
  type: Id,
  session_id: Schema.optionalKey(Id),
  profile: Schema.optionalKey(Id),
  seq: Schema.optionalKey(Natural),
  replay_epoch: Schema.optionalKey(Id),
  authority_epoch: Schema.optionalKey(Natural),
  execution_generation: Schema.optionalKey(Natural),
  admission_id: Schema.optionalKey(Id),
  payload: Schema.Unknown,
});
export const ChatDelta = Schema.Struct({
  text: Schema.NullOr(Text),
  turn_id: Schema.optionalKey(Id),
  segment: Schema.optionalKey(Natural),
  offset: Schema.optionalKey(Natural),
});
export const ChatComplete = Schema.Struct({ text: Text, status: Schema.optionalKey(Id) });
export const ChatSettled = Schema.Struct({ prompt_id: Id });
export const ChatPromptEvent = Schema.Struct({
  prompt_id: Id,
  execution_generation: Natural,
  choices: Choices,
  command: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  question: Schema.optionalKey(Text),
  multi_select: Schema.optionalKey(Schema.Boolean),
  edit: Schema.optionalKey(Schema.Null),
});

export function decodeChat<A>(schema: Schema.Decoder<A>, value: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    // Parser inputs can contain remote text or credentials. Retain no cause or remote error body.
    throw new HermesChatFailure({ code: "invalid-response" });
  }
}
