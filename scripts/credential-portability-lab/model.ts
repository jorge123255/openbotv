import { Schema } from "effect";

const Id = Schema.String.check(Schema.isPattern(/^fixture-[a-z0-9-]{1,80}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Scope = Schema.String.check(Schema.isPattern(/^fixture:\/\/[a-z0-9/-]{1,80}$/));
const Secret = Schema.String.check(Schema.isPattern(/^synthetic-secret-[a-f0-9]{64}$/));
const References = Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(4));
const common = {
  credentialId: Id,
  accountId: Id,
  agentIds: References,
  scope: Scope,
  adapterVersion: Schema.Literal(1),
};
const Portable = Schema.Struct({
  ...common,
  kind: Schema.Literals(["api-key", "refresh-token"]),
  status: Schema.Literal("synthetic-portable"),
  secret: Secret,
});
const Reauthenticate = Schema.Struct({
  ...common,
  kind: Schema.Literals(["device-oauth", "browser-login"]),
  status: Schema.Literal("reauthentication-required"),
  reason: Schema.Literal("os-or-device-bound"),
});
const Unavailable = Schema.Struct({
  ...common,
  kind: Schema.Literal("hardware-key"),
  status: Schema.Literal("unavailable"),
  reason: Schema.Literal("nonexportable"),
});
const Binding = Schema.Struct({
  transferId: Id,
  sourceId: Id,
  destinationId: Id,
  snapshotSha256: Digest,
  baselineSha256: Digest,
});
const Payload = Schema.Struct({
  format: Schema.Literal("openbot-synthetic-credential-envelope"),
  version: Schema.Literal(1),
  binding: Binding,
  accounts: Schema.Array(Schema.Struct({ id: Id })).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  agents: Schema.Array(Schema.Struct({ id: Id, accountId: Id })).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  credentials: Schema.Array(Schema.Union([Portable, Reauthenticate, Unavailable])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
});

export type FixturePayload = typeof Payload.Type;

export class CredentialLabFailure extends Schema.TaggedError<CredentialLabFailure>()("CredentialLabFailure", {
  code: Schema.Literals([
    "PAYLOAD_REJECTED",
    "CONTEXT_MISMATCH",
    "APPROVAL_REQUIRED",
    "ADAPTER_UNAVAILABLE",
    "KEY_UNAVAILABLE",
    "REVISION_CONFLICT",
    "REPLAY_REFUSED",
    "CANDIDATE_VERIFICATION_FAILED",
    "INJECTED_FAILURE",
    "ACTIVATION_UNAVAILABLE",
    "DIAGNOSTIC_REFUSED",
    "SOURCE_VALUE_MISMATCH",
  ]),
}) {}

/** Private expected context is derived from generated fixtures, never from an incoming envelope. */
export function contextOf(payload: FixturePayload) {
  return {
    binding: payload.binding,
    accounts: payload.accounts,
    agents: payload.agents,
    credentials: payload.credentials.map((record) => {
      const identity = {
        credentialId: record.credentialId,
        accountId: record.accountId,
        agentIds: record.agentIds,
        scope: record.scope,
        adapterVersion: record.adapterVersion,
        kind: record.kind,
        status: record.status,
      };
      return record.status === "synthetic-portable" ? identity : { ...identity, reason: record.reason };
    }),
  };
}

export type FixtureContext = ReturnType<typeof contextOf>;

/** Authenticated bytes still need strict private-format, reference and independent binding checks. */
export function decodeFixturePayload(bytes: Uint8Array, expected: FixtureContext): FixturePayload {
  try {
    if (bytes.byteLength > 16 * 1024) throw new Error("bounded fixture");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = JSON.parse(text);
    // This private format rejects whitespace/duplicate keys, not just unknown schema fields.
    if (JSON.stringify(parsed) !== text) throw new Error("canonical fixture");
    const payload = Schema.decodeUnknownSync(Payload, { onExcessProperty: "error" })(parsed);
    const accounts = new Set(payload.accounts.map((account) => account.id));
    const agents = new Map(payload.agents.map((agent) => [agent.id, agent.accountId]));
    const credentials = new Set(payload.credentials.map((record) => record.credentialId));
    if (
      accounts.size !== payload.accounts.length ||
      agents.size !== payload.agents.length ||
      credentials.size !== payload.credentials.length
    )
      throw new Error("duplicate fixture identity");
    if (payload.agents.some((agent) => !accounts.has(agent.accountId))) throw new Error("fixture account");
    for (const record of payload.credentials) {
      if (
        !accounts.has(record.accountId) ||
        new Set(record.agentIds).size !== record.agentIds.length ||
        record.agentIds.some((id) => agents.get(id) !== record.accountId)
      )
        throw new Error("fixture association");
    }
    if (JSON.stringify(contextOf(payload)) !== JSON.stringify(expected))
      throw new CredentialLabFailure({ code: "CONTEXT_MISMATCH" });
    return payload;
  } catch (error) {
    if (error instanceof CredentialLabFailure) throw error;
    throw new CredentialLabFailure({ code: "PAYLOAD_REJECTED" });
  }
}
