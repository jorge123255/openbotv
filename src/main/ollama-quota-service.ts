import { createHash, randomUUID } from "node:crypto";
import {
  type AgentModelOption,
  type AgentSummary,
  DEFAULT_CUSTOM_PROVIDER_HARNESS,
  isOllamaCloudBaseUrl,
  OLLAMA_QUOTA_FRESH_MS,
  type OllamaQuotaSnapshot,
  type OllamaQuotaWindow,
} from "@openbot/contracts/ipc";
import { Effect, Semaphore } from "effect";
import type { CustomProviderConfig } from "../backend/opencode-config";
import { type OllamaBalance, type OllamaBalanceFetch, readOllamaBalance } from "./ollama-balance";

export interface OllamaQuotaDependencies {
  configs(): readonly CustomProviderConfig[];
  agents(): readonly Pick<AgentSummary, "id" | "model" | "provider">[];
  models(): readonly Pick<AgentModelOption, "id" | "provider">[];
  fetchImpl?: OllamaBalanceFetch;
  now?: () => number;
}

interface Latch {
  window: string;
  armed: boolean;
  warningId: string | null;
  dismissed: boolean;
}
interface Pool {
  id: string;
  reading: OllamaBalance | null;
  checkedAt: number | null;
  failed: boolean;
  latches: Map<OllamaQuotaWindow["id"], Latch>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Local daemon access and arbitrary custom headers do not prove which cloud account pays. */
function eligible(config: CustomProviderConfig): boolean {
  return Boolean(config.apiKey?.trim()) && config.headers.length === 0 && isOllamaCloudBaseUrl(config.baseUrl);
}

/** One local owner for rate limits, cache and warning episodes across agents and app windows. */
export class OllamaQuotaService {
  readonly #deps: OllamaQuotaDependencies;
  readonly #now: () => number;
  readonly #gate = Semaphore.makeUnsafe(1);
  readonly #pools = new Map<string, Pool>();
  readonly #waiting = new Map<string, number>();
  readonly #controllers = new Set<AbortController>();
  readonly #listeners = new Set<() => void>();
  #nextRequestAt = 0;
  #epoch = 0;
  #closed = false;

  constructor(dependencies: OllamaQuotaDependencies) {
    this.#deps = dependencies;
    this.#now = dependencies.now ?? Date.now;
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Before and after a saved-connection mutation. No secret or account metadata is broadcast. */
  invalidate(): void {
    this.#epoch++;
    this.#waiting.clear();
    for (const controller of this.#controllers) controller.abort();
    const kept = new Set(
      this.#deps
        .configs()
        .filter(eligible)
        .map((config) => digest(config.apiKey ?? "")),
    );
    for (const [key, pool] of this.#pools) {
      if (!kept.has(key)) {
        this.#pools.delete(key);
        continue;
      }
      pool.reading = null;
      pool.checkedAt = null;
    }
    this.#changed();
  }

  dismiss(warningId: string): void {
    for (const pool of this.#pools.values())
      for (const latch of pool.latches.values()) if (latch.warningId === warningId) latch.dismissed = true;
    this.#changed();
  }

  dispose(): void {
    this.#closed = true;
    this.invalidate();
    this.#listeners.clear();
    this.#pools.clear();
  }

  readonly read = Effect.fn("OllamaQuota.read")(function* (this: OllamaQuotaService, agentId: string) {
    return yield* this.#gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const binding = this.#binding(agentId);
        if (this.#closed || !binding) return null;
        const { config, fingerprint, key } = binding;
        let pool = this.#pools.get(key);
        if (!pool) {
          pool = { id: randomUUID(), reading: null, checkedAt: null, failed: false, latches: new Map() };
          this.#pools.set(key, pool);
        }
        const epoch = this.#epoch;
        const due = pool.checkedAt === null || this.#now() - pool.checkedAt >= 60_000;
        // A closed view cannot hold the queue past two polls. Visible accounts take turns.
        for (const [waiting, requestedAt] of this.#waiting)
          if (this.#now() - requestedAt > 30_000) this.#waiting.delete(waiting);
        if (due) this.#waiting.set(key, this.#now());
        if (this.#now() >= this.#nextRequestAt && due && this.#waiting.keys().next().value === key) {
          this.#waiting.delete(key);
          // Global across credentials too: multiple keys can belong to the same user/team pool.
          this.#nextRequestAt = this.#now() + 60_000;
          const controller = new AbortController();
          this.#controllers.add(controller);
          const result = yield* readOllamaBalance(
            config.apiKey ?? "",
            this.#now,
            this.#deps.fetchImpl ?? fetch,
            controller,
          ).pipe(Effect.result, Effect.ensuring(Effect.sync(() => this.#controllers.delete(controller))));
          if (this.#closed || epoch !== this.#epoch || this.#binding(agentId)?.fingerprint !== fingerprint) return null;
          if (result._tag === "Success") {
            pool.reading = result.success;
            pool.checkedAt = this.#now();
            pool.failed = false;
            this.#updateWarnings(pool);
          } else {
            pool.failed = true;
            this.#nextRequestAt = Math.max(this.#nextRequestAt, this.#now() + result.failure.retryAfterMs);
          }
        }
        if (this.#binding(agentId)?.fingerprint !== fingerprint) return null;
        const fresh =
          !pool.failed &&
          pool.checkedAt !== null &&
          this.#now() >= pool.checkedAt &&
          this.#now() - pool.checkedAt < OLLAMA_QUOTA_FRESH_MS;
        return {
          connectionId: config.id,
          connectionName: config.name,
          poolId: pool.id,
          state: fresh ? "fresh" : pool.reading ? "stale" : "unavailable",
          checkedAt: pool.checkedAt,
          retryAt: this.#nextRequestAt,
          windows: (pool.reading?.windows ?? []).map((window) => ({
            ...window,
            warningId:
              fresh &&
              window.usedPercent !== null &&
              window.usedPercent >= 90 &&
              (window.resetsAt === null || window.resetsAt > this.#now()) &&
              !pool.latches.get(window.id)?.dismissed
                ? (pool.latches.get(window.id)?.warningId ?? null)
                : null,
          })),
          purchasedBalanceUsd: pool.reading?.purchasedBalanceUsd ?? null,
        } satisfies OllamaQuotaSnapshot;
      }),
    );
  });

  #binding(agentId: string) {
    const agent = this.#deps.agents().find((candidate) => candidate.id === agentId);
    if (!agent) return null;
    const config = this.#deps
      .configs()
      .find(
        (candidate) =>
          (candidate.harness ?? DEFAULT_CUSTOM_PROVIDER_HARNESS) === agent.provider &&
          candidate.models.some((model) => `${candidate.id}/${model.id}` === agent.model),
      );
    if (
      !config ||
      !eligible(config) ||
      !this.#deps.models().some((model) => model.provider === agent.provider && model.id === agent.model)
    )
      return null;
    return {
      config,
      key: digest(config.apiKey ?? ""),
      fingerprint: digest(JSON.stringify([config, agent.provider, agent.model])),
    };
  }

  #updateWarnings(pool: Pool): void {
    for (const window of pool.reading?.windows ?? []) {
      if (window.usedPercent === null) continue;
      const identity = JSON.stringify([window.startsAt, window.resetsAt]);
      let latch = pool.latches.get(window.id);
      if (!latch || latch.window !== identity) {
        latch = { window: identity, armed: true, warningId: null, dismissed: false };
        pool.latches.set(window.id, latch);
      }
      if (window.usedPercent < 85) {
        latch.armed = true;
        latch.warningId = null;
        latch.dismissed = false;
      }
      if (window.usedPercent >= 90 && latch.armed) {
        latch.armed = false;
        latch.warningId = randomUUID();
        latch.dismissed = false;
      }
    }
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
