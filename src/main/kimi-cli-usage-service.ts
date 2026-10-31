import type { ConnectKimiCliUsageInput, KimiCliUsageSnapshot } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { type KimiCliFetch, type KimiCliIdentity, readKimiCliUsage } from "./kimi-cli-usage-api";

function empty(): KimiCliUsageSnapshot {
  return {
    connected: false,
    port: null,
    state: "disconnected",
    reason: null,
    checkedAt: null,
    retryAt: 0,
    windows: [],
    extraBalanceCents: null,
    currency: null,
  };
}

/** One memory-only connection. No polling, CLI launch, persistence, prompts or warning automation. */
export class KimiCliUsageService {
  readonly #gate = Semaphore.makeUnsafe(1);
  readonly #fetch: KimiCliFetch;
  readonly #now: () => number;
  #connection: { port: number; token: string; identity: KimiCliIdentity | null } | null = null;
  #snapshot = empty();
  #epoch = 0;
  #nextRead = 0;
  #controller: AbortController | null = null;
  #disposed = false;

  constructor(deps: { fetchImpl?: KimiCliFetch; now?: () => number } = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? Date.now;
  }
  get(): KimiCliUsageSnapshot {
    return structuredClone(this.#snapshot);
  }
  disconnect(): KimiCliUsageSnapshot {
    this.#epoch++;
    this.#controller?.abort();
    this.#controller = null;
    this.#connection = null;
    this.#snapshot = empty();
    return this.get();
  }
  dispose(): void {
    this.#disposed = true;
    this.disconnect();
  }

  connect = Effect.fn("KimiCliUsage.connect")((input: ConnectKimiCliUsageInput) =>
    Effect.gen({ self: this }, function* () {
      if (this.#disposed) return this.get();
      this.disconnect();
      registerSecretValue(input.token, { allowShort: true });
      this.#connection = { port: input.port, token: input.token, identity: null };
      this.#snapshot = {
        ...empty(),
        connected: true,
        port: input.port,
        state: "unavailable",
        reason: "request",
        retryAt: this.#nextRead,
      };
      return yield* this.read();
    }),
  );

  read = Effect.fn("KimiCliUsage.read")(() => {
    const generation = this.#epoch;
    return Effect.gen({ self: this }, function* () {
      const connection = this.#connection;
      if (this.#disposed || !connection || generation !== this.#epoch) return this.get();
      if (this.#now() < this.#nextRead) return this.get();
      this.#nextRead = this.#now() + 60_000;
      const controller = new AbortController();
      this.#controller = controller;
      const result = yield* Effect.result(
        readKimiCliUsage(connection.port, connection.token, this.#fetch, controller, connection.identity),
      );
      if (generation !== this.#epoch || this.#disposed) return this.get();
      this.#controller = null;
      if (result._tag === "Failure") {
        const reason = result.failure.reason;
        if (
          reason === "accountChanged" ||
          reason === "serverChanged" ||
          reason === "unsafe" ||
          reason === "unsupported"
        )
          this.#connection = null;
        this.#snapshot = {
          ...empty(),
          connected: this.#connection !== null,
          port: this.#connection?.port ?? null,
          state: "unavailable",
          reason,
          retryAt: this.#nextRead,
        };
      } else {
        connection.identity = result.success.identity;
        this.#snapshot = {
          connected: true,
          port: connection.port,
          state: "ready",
          reason: null,
          checkedAt: this.#now(),
          retryAt: this.#nextRead,
          windows: result.success.windows,
          extraBalanceCents: result.success.extraBalanceCents,
          currency: result.success.currency,
        };
      }
      return this.get();
    }).pipe(this.#gate.withPermits(1));
  });
}
