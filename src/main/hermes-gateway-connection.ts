import { registerSecretValue } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import WebSocket from "ws";
import { HermesGatewayChatTransport } from "./hermes-gateway-chat-transport";
import { type GatewayRoute, gatewayRequest, HermesGatewayCookies } from "./hermes-gateway-http";
import { authorizeHermesPassword, type HermesGatewayBrowser } from "./hermes-gateway-native-auth";
import {
  decodeGateway,
  GatewayIdentity,
  GatewayLogin,
  GatewayProfiles,
  GatewayProviders,
  GatewayStatus,
  GatewayTicket,
  gatewayAddress,
  HermesGatewayFailure,
} from "./hermes-gateway-protocol";

/** Main-only authentication owner. Staged chat transports share its lifetime, never its renderer. */
export class HermesGatewayConnection {
  readonly #base: URL;
  readonly #cookies = new HermesGatewayCookies();
  readonly #lifetime = new AbortController();
  readonly #lock = Semaphore.makeUnsafe(1);
  readonly #chats = new Set<HermesGatewayChatTransport>();
  #authenticated = false;
  #nativeAccess: { token: string; expiresAt: number } | null = null;

  private constructor(base: URL) {
    this.#base = base;
  }

  static readonly create = Effect.fn("HermesGatewayConnection.create")(function* (address: string) {
    return yield* Effect.try({
      try: () => new HermesGatewayConnection(gatewayAddress(address)),
      catch: (error) =>
        error instanceof HermesGatewayFailure ? error : new HermesGatewayFailure({ code: "invalid-address" }),
    });
  });

  readonly probe = Effect.fn("HermesGatewayConnection.probe")(function (this: HermesGatewayConnection) {
    return this.#operate((signal) => this.#discover(signal));
  }).bind(this);

  readonly signInPassword = Effect.fn("HermesGatewayConnection.signInPassword")(function (
    this: HermesGatewayConnection,
    provider: string,
    username: string,
    password: string,
  ) {
    return this.#operate(async (signal) => {
      this.#clearSession();
      if (!username || username.length > 256 || !password || password.length > 16_384)
        throw new HermesGatewayFailure({ code: "authentication" });
      registerSecretValue(password, { allowShort: true });
      const discovery = await this.#discover(signal);
      if (!discovery.providers.some((item) => item.name === provider && item.supports_password))
        throw new HermesGatewayFailure({ code: "unsupported-auth" });
      const login = await this.#request(
        "/auth/password-login",
        signal,
        JSON.stringify({ provider, username, password }),
      );
      decodeGateway(GatewayLogin, login);
      const identity = decodeGateway(GatewayIdentity, await this.#request("/api/auth/me", signal));
      if (identity.provider !== provider || identity.expires_at * 1_000 <= Date.now())
        throw new HermesGatewayFailure({ code: "authentication" });
      const profiles = await this.#profiles(signal);
      const ticket = decodeGateway(GatewayTicket, await this.#request("/api/auth/ws-ticket", signal, "{}"));
      registerSecretValue(ticket.ticket, { allowShort: true });
      await checkGatewaySocket(this.#base, ticket.ticket, signal);
      signal.throwIfAborted();
      this.#authenticated = true;
      return { profiles, socket: "verified" as const, chat: "unavailable" as const };
    });
  }).bind(this);

  readonly signInBrowser = Effect.fn("HermesGatewayConnection.signInBrowser")(function (
    this: HermesGatewayConnection,
    provider: string,
    openBrowser: HermesGatewayBrowser,
  ) {
    return this.#operate(async (signal) => {
      this.#clearSession();
      const discovery = await this.#discover(signal);
      if (
        !discovery.nativePassword ||
        !discovery.providers.some((item) => item.name === provider && item.supports_password)
      )
        throw new HermesGatewayFailure({ code: "unsupported-auth" });
      const tokens = await authorizeHermesPassword(this.#base, provider, signal, openBrowser);
      this.#nativeAccess = { token: tokens.access_token, expiresAt: tokens.expires_at * 1_000 };
      const identity = decodeGateway(GatewayIdentity, await this.#request("/api/auth/me", signal));
      if (identity.provider !== provider || identity.user_id !== tokens.user_id)
        throw new HermesGatewayFailure({ code: "authentication" });
      const profiles = await this.#profiles(signal);
      const ticket = decodeGateway(GatewayTicket, await this.#request("/api/auth/ws-ticket", signal, "{}"));
      registerSecretValue(ticket.ticket);
      await checkGatewaySocket(this.#base, ticket.ticket, signal);
      signal.throwIfAborted();
      this.#authenticated = true;
      return { profiles, expiresAt: this.#nativeAccess.expiresAt };
    });
  }).bind(this);

  readonly listProfiles = Effect.fn("HermesGatewayConnection.listProfiles")(function (this: HermesGatewayConnection) {
    return this.#operate(async (signal) => {
      if (!this.#authenticated) throw new HermesGatewayFailure({ code: "authentication" });
      return this.#profiles(signal);
    });
  }).bind(this);

  /** Main-only staged transport. Creating it does not dial, attach, or send a turn. */
  readonly createChatTransport = Effect.fn("HermesGatewayConnection.createChatTransport")(function (
    this: HermesGatewayConnection,
    profile: string,
  ) {
    // Pinned hermes_constants.PROFILE_ID_RE. Never let an empty selector route to the launch profile.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profile)) return Effect.fail(new HermesGatewayFailure({ code: "profile" }));
    return this.#operate(async (signal) => {
      const access = this.#nativeAccess;
      if (!this.#authenticated || !access) throw new HermesGatewayFailure({ code: "authentication" });
      if (this.#chats.size >= 4) throw new HermesGatewayFailure({ code: "limit" });
      const profiles = await this.#profiles(signal);
      if (!profiles.some((item) => item.name === profile)) throw new HermesGatewayFailure({ code: "profile" });
      signal.throwIfAborted();
      if (access.expiresAt <= Date.now()) throw new HermesGatewayFailure({ code: "authentication" });
      const chat = new HermesGatewayChatTransport({
        base: new URL(this.#base),
        profile,
        owner: this.#lifetime.signal,
        expiresAt: access.expiresAt,
        // Native bearer grants do not mutate a cookie jar. Cancelling this one dial must not
        // sign out sibling profile transports. Authentication refusal still invalidates the owner.
        mintTicket: Effect.tryPromise({
          try: async (cancel) => {
            if (!this.#authenticated || this.#nativeAccess !== access || access.expiresAt <= Date.now())
              throw new HermesGatewayFailure({ code: "authentication" });
            const signal = AbortSignal.any([cancel, this.#lifetime.signal]);
            const reply = await gatewayRequest(this.#base, "/api/auth/ws-ticket", signal, "", "{}", access.token);
            const ticket = decodeGateway(GatewayTicket, reply.body).ticket;
            registerSecretValue(ticket);
            return ticket;
          },
          catch: (error) => {
            const failure =
              error instanceof HermesGatewayFailure ? error : new HermesGatewayFailure({ code: "transport" });
            if (failure.code === "authentication") this.#clearSession();
            return failure;
          },
        }).pipe(this.#lock.withPermits(1)),
        onClose: (transport) => this.#chats.delete(transport),
      });
      if (chat.state().phase === "closed") throw new HermesGatewayFailure({ code: "authentication" });
      this.#chats.add(chat);
      return chat;
    });
  }).bind(this);

  /** Local sign-out is terminal and immediate, including during login. Reconnect uses a new object. */
  close(): void {
    this.#lifetime.abort();
    this.#clearSession();
  }

  /** Application shutdown also waits for the aborted sign-in and callback listener to unwind. */
  readonly dispose = Effect.fn("HermesGatewayConnection.dispose")(function (this: HermesGatewayConnection) {
    this.close();
    return this.#lock.withPermits(1)(Effect.succeed(undefined));
  }).bind(this);

  #clearSession(): void {
    for (const chat of [...this.#chats]) chat.close();
    this.#chats.clear();
    this.#authenticated = false;
    this.#nativeAccess = null;
    this.#cookies.clear();
  }

  #operate<A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, HermesGatewayFailure> {
    return Effect.tryPromise({
      try: async (cancel) => {
        if (this.#lifetime.signal.aborted) throw new HermesGatewayFailure({ code: "closed" });
        const signal = AbortSignal.any([cancel, this.#lifetime.signal]);
        try {
          return await work(signal);
        } catch (error) {
          // Local factory validation has sent no turn or credential mutation. Refusing an
          // unlisted profile or a resource limit must not sign out existing profile transports.
          if (!(error instanceof HermesGatewayFailure && (error.code === "profile" || error.code === "limit")))
            this.#clearSession();
          if (this.#lifetime.signal.aborted) throw new HermesGatewayFailure({ code: "closed" });
          throw error;
        } finally {
          if (signal.aborted) this.#clearSession();
        }
      },
      catch: (error) =>
        error instanceof HermesGatewayFailure ? error : new HermesGatewayFailure({ code: "transport" }),
    }).pipe(this.#lock.withPermits(1));
  }

  async #discover(signal: AbortSignal) {
    // Public discovery must never send or accept session cookies.
    const status = decodeGateway(GatewayStatus, (await gatewayRequest(this.#base, "/api/status", signal, "")).body);
    if (!status.auth_required) throw new HermesGatewayFailure({ code: "unsupported-auth" });
    const providers = decodeGateway(
      GatewayProviders,
      (await gatewayRequest(this.#base, "/api/auth/providers", signal, "")).body,
    );
    return {
      authRequired: true as const,
      providers: providers.providers,
      nativePassword: status.auth_flows?.includes("native_pkce") ?? false,
      oauth: "unavailable" as const,
    };
  }

  async #profiles(signal: AbortSignal) {
    // Schema projection omits remote paths, environment flags, model config and unknown fields.
    return decodeGateway(GatewayProfiles, await this.#request("/api/profiles", signal)).profiles;
  }

  async #request(route: GatewayRoute, signal: AbortSignal, body?: string): Promise<string> {
    const path = `${this.#base.pathname.replace(/\/$/u, "")}${route}`;
    if (this.#nativeAccess && this.#nativeAccess.expiresAt <= Date.now())
      throw new HermesGatewayFailure({ code: "authentication" });
    const reply = await gatewayRequest(
      this.#base,
      route,
      signal,
      this.#nativeAccess ? "" : this.#cookies.header(path),
      body,
      this.#nativeAccess?.token,
    );
    signal.throwIfAborted();
    if (!this.#nativeAccess) this.#cookies.record(this.#base, reply.cookies);
    return reply.body;
  }
}

/** Verify only the authenticated upgrade. Send no RPC, turns or approvals, and never reconnect. */
function checkGatewaySocket(base: URL, ticket: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base.origin}${base.pathname.replace(/\/$/u, "")}/api/ws`);
    url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, ["hermes-gateway-v1", `hermes-gateway-ticket.${ticket}`], {
      origin: base.origin,
      rejectUnauthorized: true,
      followRedirects: false,
      handshakeTimeout: 8_000,
      maxPayload: 65_536,
      perMessageDeflate: false,
    });
    let admitted = false;
    const fail = () => {
      reject(new HermesGatewayFailure({ code: "socket-rejected" }));
      socket.terminate();
    };
    const deadline = setTimeout(fail, 8_000);
    signal.addEventListener("abort", fail, { once: true });
    socket.on("error", fail);
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      fail();
    });
    socket.on("open", () => {
      if (socket.protocol !== "hermes-gateway-v1" || signal.aborted) return fail();
      admitted = true;
      socket.close(1000);
    });
    socket.on("close", (code) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", fail);
      if (admitted && code === 1000 && !signal.aborted) resolve();
      else reject(new HermesGatewayFailure({ code: "socket-rejected" }));
    });
    if (signal.aborted) fail();
  });
}
