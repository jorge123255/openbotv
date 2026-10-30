import type { GrokBotAgentSummary, GrokBotImportResult } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { GROK_BOT_MODEL_ID } from "../backend/grok-bot/grok-bot-inference";

/** The narrow slice of the agent store an import touches, so a test can stand in for it. */
export interface GrokBotImportStore {
  readonly database: { listExternalSessionIds(): string[] };
  createAgent(input: {
    name: string;
    description: string;
    avatarSeed: string;
    avatarHue: null;
  }): Effect.Effect<{ id: string }, { readonly cause: unknown }>;
  updateAgent(input: {
    agentId: string;
    provider: "grok-bot";
    model: string;
    title?: string;
  }): Effect.Effect<unknown, { readonly cause: unknown }>;
  ensureThreadIdNow(id: string): string;
  bindProviderSession(id: string, provider: "grok-bot", externalSessionId: string): unknown;
}

/**
 * Mirrors Grok Bot agents into this Mac's OpenBot roster, read-only toward Grok Bot.
 *
 * Each remote agent becomes a local `grok-bot` agent whose own thread is bound to the remote
 * agent id as its provider session, so its first turn resumes that agent instead of calling
 * `createGrokBotAgent`. The binding is also the dedupe key: an id already bound on this computer is
 * skipped. Hidden agents and rooms are skipped. Nothing is ever written to Grok Bot.
 */
export const importGrokBotAgents = Effect.fn("GrokBotAgentImport.import")(function* (
  remote: readonly GrokBotAgentSummary[],
  store: GrokBotImportStore,
) {
  const bound = new Set(store.database.listExternalSessionIds());
  const imported: string[] = [];
  let skipped = 0;
  for (const agent of remote) {
    if (agent.hidden || agent.room || !agent.id || bound.has(agent.id)) {
      skipped += 1;
      continue;
    }
    const created = yield* store.createAgent({
      name: (agent.name.trim() || "Grok Bot").slice(0, 80),
      description: agent.description.slice(0, 2000),
      avatarSeed: avatarSeed(agent.id),
      avatarHue: null,
    });
    yield* store.updateAgent({
      agentId: created.id,
      provider: "grok-bot",
      model: GROK_BOT_MODEL_ID,
      ...(agent.title.trim() ? { title: agent.title.trim().slice(0, 80) } : {}),
    });
    store.ensureThreadIdNow(created.id);
    store.bindProviderSession(created.id, "grok-bot", agent.id);
    bound.add(agent.id);
    imported.push(created.id);
  }
  const result: GrokBotImportResult = { imported: imported.length, skipped, agentIds: imported };
  return result;
});

function avatarSeed(id: string): string {
  const seed = `grok-bot:${id.toLowerCase().replace(/[^a-z0-9:-]/gu, "-")}`;
  return seed.slice(0, 128);
}
