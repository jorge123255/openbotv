import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type GrokBotImportStore, importGrokBotAgents } from "./grok-bot-agent-import";

function fakeStore(boundIds: string[] = []) {
  const created: Array<{ id: string; name: string }> = [];
  const updates: unknown[] = [];
  const binds: Array<[string, string, string]> = [];
  const store: GrokBotImportStore = {
    database: { listExternalSessionIds: () => [...boundIds] },
    createAgent: (input) => {
      const agent = { id: `agent-${created.length + 1}`, name: input.name };
      created.push(agent);
      return Effect.succeed(agent);
    },
    updateAgent: (input) => {
      updates.push(input);
      return Effect.succeed({});
    },
    ensureThreadIdNow: (id) => `thread-${id}`,
    bindProviderSession: (id, provider, external) => {
      binds.push([id, provider, external]);
      return {};
    },
  };
  return { store, created, updates, binds };
}

const remote = (id: string, extra: Partial<{ hidden: boolean; room: boolean }> = {}) => ({
  id,
  name: `Bot ${id}`,
  title: "",
  description: "",
  hidden: false,
  room: false,
  ...extra,
});

describe("importGrokBotAgents", () => {
  it("binds each new remote agent as a grok-bot session and skips hidden, rooms, and already bound ids", async () => {
    const fake = fakeStore(["b"]);
    const result = await Effect.runPromise(
      importGrokBotAgents(
        [remote("a"), remote("b"), remote("c", { hidden: true }), remote("d", { room: true })],
        fake.store,
      ),
    );
    expect(result).toEqual({ imported: 1, skipped: 3, agentIds: ["agent-1"] });
    expect(fake.binds).toEqual([["agent-1", "grok-bot", "a"]]);
    expect(fake.updates).toEqual([{ agentId: "agent-1", provider: "grok-bot", model: "default" }]);
  });

  it("is idempotent within one run for duplicate remote ids", async () => {
    const fake = fakeStore();
    const result = await Effect.runPromise(importGrokBotAgents([remote("a"), remote("a")], fake.store));
    expect(result.imported).toBe(1);
  });
});
