import { randomUUID } from "node:crypto";
import type { HermesGatewaySetup } from "@openbot/contracts/ipc";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { HermesGatewayConnection } from "./hermes-gateway-connection";
import type { HermesGatewayBrowser } from "./hermes-gateway-native-auth";
import { gatewayAddress, HermesGatewayFailure } from "./hermes-gateway-protocol";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";

const RememberedGateway = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  profileId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const SavedGateways = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(RememberedGateway).check(Schema.isMaxLength(8)),
});
type Remembered = typeof RememberedGateway.Type;
interface RuntimeGateway {
  view: HermesGatewaySetup;
  connection: HermesGatewayConnection | null;
}
interface SetupDependencies {
  path: string;
  now?: () => number;
  openBrowser: HermesGatewayBrowser;
  confirmRemember: (url: string, profile: string) => Promise<boolean>;
}

/** Local metadata only; no startup network, session persistence, chat, agents or database writes. */
export class HermesGatewaySetupService {
  readonly #deps: SetupDependencies;
  readonly #entries = new Map<string, RuntimeGateway>();
  readonly #saved = new Map<string, Remembered>();
  readonly #writes = Semaphore.makeUnsafe(1);
  readonly #probes = Semaphore.makeUnsafe(1);
  readonly #pending = new Set<HermesGatewayConnection>();
  #readOnly = false;
  #closed = false;
  constructor(deps: SetupDependencies) {
    this.#deps = deps;
  }

  readonly load = Effect.fn("HermesGatewaySetup.load")(function* (this: HermesGatewaySetupService) {
    const read = yield* Effect.result(
      readPreferenceFile(this.#deps.path, (value) =>
        Schema.decodeUnknownSync(SavedGateways, { onExcessProperty: "error" })(value),
      ),
    );
    if (Result.isFailure(read)) {
      this.#readOnly = !isMissingFileError(read.failure.cause);
      return;
    }
    try {
      const entries = read.success.entries.map((entry) => ({ ...entry, url: canonicalAddress(entry.url) }));
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate gateway IDs");
      for (const entry of entries) {
        this.#saved.set(entry.id, entry);
        this.#entries.set(entry.id, {
          connection: null,
          view: {
            id: entry.id,
            url: entry.url,
            selectedProfileId: entry.profileId,
            remembered: true,
            phase: "signed-out",
            expiresAt: null,
            providers: [],
            profiles: [],
          },
        });
      }
    } catch {
      this.#readOnly = true;
    }
  }).bind(this);

  list(): HermesGatewaySetup[] {
    for (const entry of this.#entries.values()) {
      if (entry.view.expiresAt !== null && entry.view.expiresAt <= (this.#deps.now?.() ?? Date.now()))
        this.#disconnect(entry);
    }
    return [...this.#entries.values()].map(({ view }) => ({
      ...view,
      providers: view.providers.map((provider) => ({ ...provider })),
      profiles: view.profiles.map((profile) => ({ ...profile })),
    }));
  }

  readonly probe = Effect.fn("HermesGatewaySetup.probe")(function (
    this: HermesGatewaySetupService,
    url: string,
    id?: string,
  ) {
    return this.#probes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#closed) return yield* new HermesGatewayFailure({ code: "closed" });
        const previous = id ? yield* this.#entry(id) : null;
        if (!previous && this.#entries.size >= 8) return yield* new HermesGatewayFailure({ code: "limit" });
        const connection = yield* HermesGatewayConnection.create(url);
        const address = canonicalAddress(url);
        if (previous && previous.view.url !== address)
          return yield* new HermesGatewayFailure({ code: "invalid-address" });
        this.#pending.add(connection);
        let retained = false;
        return yield* connection.probe().pipe(
          Effect.flatMap((discovery) => {
            if (this.#closed || (id && this.#entries.get(id) !== previous))
              return Effect.fail(new HermesGatewayFailure({ code: "closed" }));
            previous?.connection?.close();
            const gatewayId = id ?? randomUUID();
            this.#entries.set(gatewayId, {
              connection,
              view: {
                id: gatewayId,
                url: address,
                phase: "discovered",
                remembered: previous?.view.remembered ?? false,
                selectedProfileId: previous?.view.selectedProfileId ?? null,
                expiresAt: null,
                profiles: [],
                providers: discovery.providers.map((provider) => ({
                  id: provider.name,
                  name: provider.display_name || provider.name,
                  supported: discovery.nativePassword && provider.supports_password,
                })),
              },
            });
            retained = true;
            return Effect.succeed(this.list());
          }),
          Effect.onExit(() =>
            Effect.sync(() => {
              this.#pending.delete(connection);
              if (!retained) connection.close();
            }),
          ),
        );
      }),
    );
  }).bind(this);

  readonly signIn = Effect.fn("HermesGatewaySetup.signIn")(function* (
    this: HermesGatewaySetupService,
    id: string,
    providerId: string,
  ) {
    const entry = yield* this.#entry(id);
    if (entry.view.phase === "signing-in") return yield* new HermesGatewayFailure({ code: "busy" });
    // Remembered gateways are not probed at startup. Explicit sign-in discovers capabilities again.
    const connection = yield* HermesGatewayConnection.create(entry.view.url);
    entry.connection?.close();
    entry.connection = connection;
    entry.view.phase = "signing-in";
    entry.view.profiles = [];
    entry.view.expiresAt = null;
    this.#pending.add(connection);
    return yield* connection.signInBrowser(providerId, this.#deps.openBrowser).pipe(
      Effect.flatMap((result) => {
        if (entry.connection !== connection || this.#entries.get(id) !== entry)
          return Effect.fail(new HermesGatewayFailure({ code: "closed" }));
        entry.view.phase = "connected";
        entry.view.expiresAt = result.expiresAt;
        entry.view.profiles = result.profiles.map((profile) => ({
          id: profile.name,
          name: profile.display_name || profile.name,
        }));
        if (
          entry.view.selectedProfileId &&
          !entry.view.profiles.some((profile) => profile.id === entry.view.selectedProfileId)
        )
          entry.view.selectedProfileId = null;
        return Effect.succeed(this.list());
      }),
      Effect.onExit(() =>
        Effect.sync(() => {
          this.#pending.delete(connection);
        }),
      ),
      Effect.onError(() =>
        Effect.sync(() => {
          if (entry.connection === connection) this.#disconnect(entry);
        }),
      ),
    );
  }).bind(this);

  readonly selectProfile = Effect.fn("HermesGatewaySetup.selectProfile")(function* (
    this: HermesGatewaySetupService,
    id: string,
    profileId: string,
    remember: boolean,
  ) {
    const entry = yield* this.#entry(id);
    this.list();
    if (entry.view.phase !== "connected" || !entry.view.profiles.some((profile) => profile.id === profileId))
      return yield* new HermesGatewayFailure({ code: "profile" });
    if (remember) {
      const allowed = yield* Effect.tryPromise({
        try: () => this.#deps.confirmRemember(entry.view.url, profileId),
        catch: () => new HermesGatewayFailure({ code: "cancelled" }),
      });
      if (!allowed) return yield* new HermesGatewayFailure({ code: "consent" });
    }
    if (entry.view.phase !== "connected" || this.#entries.get(id) !== entry)
      return yield* new HermesGatewayFailure({ code: "closed" });
    if (remember || entry.view.remembered)
      yield* this.#save(id, remember ? { id, url: entry.view.url, profileId } : null);
    entry.view.selectedProfileId = profileId;
    entry.view.remembered = remember;
    return this.list();
  }).bind(this);

  readonly disconnect = Effect.fn("HermesGatewaySetup.disconnect")(function* (
    this: HermesGatewaySetupService,
    id: string,
  ) {
    const entry = yield* this.#entry(id);
    this.#disconnect(entry);
    return this.list();
  }).bind(this);

  readonly forget = Effect.fn("HermesGatewaySetup.forget")(function* (this: HermesGatewaySetupService, id: string) {
    const entry = yield* this.#entry(id);
    this.#disconnect(entry);
    if (entry.view.remembered) yield* this.#save(id, null);
    this.#entries.delete(id);
    return this.list();
  }).bind(this);

  readonly close = Effect.fn("HermesGatewaySetup.close")(function* (this: HermesGatewaySetupService) {
    this.#closed = true;
    const connections = new Set(this.#pending);
    for (const entry of this.#entries.values()) {
      if (entry.connection) connections.add(entry.connection);
      this.#disconnect(entry);
    }
    for (const connection of connections) connection.close();
    for (const connection of connections) yield* connection.dispose();
    yield* this.#writes.withPermit(Effect.succeed(undefined));
  }).bind(this);

  #entry(id: string) {
    return Effect.try({
      try: () => {
        const entry = this.#entries.get(id);
        if (this.#closed || !entry) throw new HermesGatewayFailure({ code: "closed" });
        return entry;
      },
      catch: () => new HermesGatewayFailure({ code: "closed" }),
    });
  }

  #disconnect(entry: RuntimeGateway): void {
    entry.connection?.close();
    entry.connection = null;
    entry.view.phase = "signed-out";
    entry.view.expiresAt = null;
    entry.view.profiles = [];
  }

  #save(id: string, value: Remembered | null) {
    return this.#writes.withPermit(
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          if (this.#readOnly) return yield* new HermesGatewayFailure({ code: "storage" });
          const next = new Map(this.#saved);
          if (value) next.set(id, value);
          else next.delete(id);
          yield* writePreferenceFile(
            this.#deps.path,
            { version: 1, entries: [...next.values()] },
            { createDirectory: true },
          ).pipe(Effect.mapError(() => new HermesGatewayFailure({ code: "storage" })));
          this.#saved.clear();
          for (const [key, entry] of next) this.#saved.set(key, entry);
        }),
      ),
    );
  }
}

function canonicalAddress(address: string): string {
  const base = gatewayAddress(address);
  return `${base.origin}${base.pathname.replace(/\/$/u, "")}`;
}
