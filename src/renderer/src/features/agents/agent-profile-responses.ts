import type { UpdateAgentInput } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { snapshot } from "solid-js";

type Field = keyof AgentProfile;
// These values form one host decision. Never combine parts of two runtime responses.
const groups: readonly (readonly Field[])[] = [
  ["provider", "model", "reasoningEffort", "providerAccountId", "pendingRuntime", "usageLimitReturn"],
  ["updatedAt", "time"],
];

function expand(fields: Set<Field>): Set<Field> {
  for (const group of groups)
    if (group.some((field) => fields.has(field))) for (const field of group) fields.add(field);
  return fields;
}

function equal(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function keys<T extends object>(value: T) {
  return Object.keys(value).filter((key): key is Extract<keyof T, string> => Object.hasOwn(value, key));
}

function changed(left: AgentProfile, right: AgentProfile): Set<Field> {
  return new Set(keys({ ...left, ...right }).filter((field) => field !== "id" && !equal(left[field], right[field])));
}

/** A response confirms its input fields, including no-op writes and host-normalized defaults. */
export function agentUpdateResponseFields(updates: Omit<UpdateAgentInput, "agentId">): Set<Field> {
  const { leaveUsageLimit, ...profileUpdates } = updates;
  const fields = new Set<Field>(keys(profileUpdates).filter((field) => profileUpdates[field] !== undefined));
  if (leaveUsageLimit !== undefined) fields.add("usageLimitReturn");
  return expand(fields);
}

interface Entry {
  head: AgentProfile;
  accepted: Map<Field, number>;
  epoch: number;
}

interface Request {
  profile: AgentProfile;
  before: AgentProfile;
  fields: Set<Field>;
  revision: number;
  epoch: number;
}

/** Own one ledger per server scope. A reply is a delta, never a replacement roster record. */
export function createAgentProfileResponses() {
  let revision = 0;
  const entries = new WeakMap<AgentProfile, Entry>();
  function entryFor(profile: AgentProfile): Entry {
    let entry = entries.get(profile);
    if (!entry) {
      entry = { head: structuredClone(snapshot(profile)), accepted: new Map(), epoch: 0 };
      entries.set(profile, entry);
    }
    return entry;
  }
  return {
    current(profile: AgentProfile): AgentProfile {
      return entryFor(profile).head;
    },
    begin(profile: AgentProfile | undefined, fields: Set<Field>): Request | undefined {
      if (!profile) return undefined;
      const entry = entryFor(profile);
      return {
        profile,
        before: structuredClone(entry.head),
        fields: expand(fields),
        revision: ++revision,
        epoch: entry.epoch,
      };
    },
    valid(request: Request | undefined, profile: AgentProfile | undefined): boolean {
      return !!request && request.profile === profile && entryFor(request.profile).epoch === request.epoch;
    },
    currentError(request: Request | undefined, profile: AgentProfile | undefined): boolean {
      if (!request || request.profile !== profile) return false;
      const entry = entryFor(profile);
      return (
        entry.epoch === request.epoch &&
        (request.fields.size === 0 ||
          [...request.fields].some((field) => (entry.accepted.get(field) ?? 0) <= request.revision))
      );
    },
    // Events have no host revision. A later observed field change takes precedence over a reply.
    observe(profile: AgentProfile, next: AgentProfile): boolean {
      const entry = entryFor(profile);
      const fields = expand(changed(entry.head, next));
      if (fields.size) {
        const observed = ++revision;
        for (const field of fields) entry.accepted.set(field, observed);
      }
      // Solid store writes are staged. Keep the accepted head current before a second callback runs.
      entry.head = structuredClone(snapshot(next));
      return fields.size > 0;
    },
    invalidate(profile: AgentProfile): void {
      // Undo can restore the same store. Its previous requests must still remain invalid.
      entryFor(profile).epoch += 1;
    },
    merge(request: Request | undefined, profile: AgentProfile, next: AgentProfile): AgentProfile | undefined {
      if (!request || request.profile !== profile) return undefined;
      const entry = entryFor(profile);
      if (entry.epoch !== request.epoch) return undefined;
      // Declared fields also confirm no-op writes; unrelated deltas need an unchanged baseline.
      const wanted = expand(new Set([...changed(request.before, next), ...request.fields]));
      const merged = { ...entry.head };
      const eligible = (field: Field) =>
        (entry.accepted.get(field) ?? 0) <= request.revision &&
        (request.fields.has(field) || equal(entry.head[field], request.before[field]));
      const assign = <K extends Field>(field: K) => {
        merged[field] = next[field];
        entry.accepted.set(field, request.revision);
      };
      for (const group of groups) {
        if (group.some((field) => wanted.has(field)) && group.every(eligible)) for (const field of group) assign(field);
        for (const field of group) wanted.delete(field);
      }
      for (const field of wanted) if (eligible(field)) assign(field);
      entry.head = structuredClone(snapshot(merged));
      return merged;
    },
  };
}
