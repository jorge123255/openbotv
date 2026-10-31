// Real main-only transport and auth adapters; synthetic pinned canonical gateway. No live app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";
import { HermesGatewayChatTransport } from "../src/main/hermes-gateway-chat-transport";
import { HermesGatewayConnection } from "../src/main/hermes-gateway-connection";

const OUTPUT = resolve(import.meta.dirname, "../.openbot-build/hermes-gateway-chat-e2e");
const cases: string[] = [];
let passed = false;
const clients: HermesGatewayConnection[] = [];
const Input = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(
    Schema.Struct({
      profile: Schema.optionalKey(Schema.String),
      session_id: Schema.optionalKey(Schema.String),
      omit_messages: Schema.optionalKey(Schema.Boolean),
      server_requests: Schema.optionalKey(Schema.Boolean),
      desktop_local: Schema.optionalKey(Schema.Boolean),
      text: Schema.optionalKey(Schema.String),
      submission_id: Schema.optionalKey(Schema.String),
      queued: Schema.optionalKey(Schema.Boolean),
      clarify_batch: Schema.optionalKey(Schema.Boolean),
      execution_generation: Schema.optionalKey(Schema.Int),
      prompt_id: Schema.optionalKey(Schema.String),
      choice: Schema.optionalKey(Schema.String),
      answer: Schema.optionalKey(Schema.String),
    }),
  ),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int })),
  result: Schema.optionalKey(Schema.Unknown),
});
interface Prompt {
  kind: "approval" | "clarify";
  prompt_id: string;
  execution_generation: number;
  choices: string[];
  question?: string;
  command?: string;
  multi_select?: boolean;
}
interface Receipt {
  admission_id: string;
  ref: { profile_id: string; session_id: string };
  sequence: number;
  status: "started" | "terminal" | "unknown";
  outcome: string | null;
  authority_epoch: number;
  execution_generation: number;
  input_id: string;
}
interface Session {
  identity: string;
  profile: string;
  id: string;
  home: string;
  generation: number;
  running: boolean;
  epoch: string;
  sequence: number;
  pending: Receipt[];
  prompts: Prompt[];
}
interface Peer {
  identity: string;
  session: Session | null;
  socket: WebSocket;
}
type Action =
  | "drop"
  | "drop-running"
  | "wrong-ref"
  | "wrong-profile"
  | "wrong-session"
  | "complete-before-ack"
  | "stage-event"
  | "hold"
  | "reply-then-invalid";
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(tls?: { key: string; cert: string }) {
  const sessions = new Map<string, Session>();
  const tokens = new Map<string, string>();
  const codes = new Map<string, { identity: string; challenge: string }>();
  const tickets = new Map<string, { identity: string; expires: number }>();
  const peers = new Set<Peer>();
  const seen: { identity: string; method: string; profile?: string; session?: string; submission?: string }[] = [];
  const secrets = new Set<string>();
  let origin = "";
  let capabilities = true;
  let authority = true;
  let rejectTickets = false;
  let next: { method: string; action: Action; reached: ReturnType<typeof deferred> } | null = null;
  let ticketGate: {
    reached: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
    closed: ReturnType<typeof deferred>;
  } | null = null;
  let upgrades = 0;
  let ticketPosts = 0;
  let nextCertificate: { key: string; cert: string } | null = null;
  let rejectedRequests = 0;
  const broadcasts = new Map<
    string,
    { status: "pending" | "failed" | "resolved"; done: ReturnType<typeof deferred> }
  >();
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    assert.equal(request.headers.origin, origin);
    assert.ok(!request.url?.includes("?"), "REST credential and profile selectors do not enter the URL.");
    const route = request.url?.replace(/^\/proxy/u, "");
    response.setHeader("content-type", "application/json");
    const json = (value: unknown) => response.end(JSON.stringify(value));
    if (route === "/api/status") return json({ auth_required: true, auth_flows: ["native_pkce"] });
    if (route === "/api/auth/providers")
      return json({ providers: [{ name: "basic", display_name: "Password", supports_password: true }] });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (route === "/auth/native/token") {
      const input = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String, code_verifier: Schema.String }))(
        JSON.parse(body),
      );
      const code = codes.get(input.code);
      assert.ok(code);
      codes.delete(input.code);
      assert.equal(createHash("sha256").update(input.code_verifier).digest("base64url"), code.challenge);
      const token = randomBytes(32).toString("base64url");
      secrets.add(token);
      tokens.set(token, code.identity);
      return json({
        access_token: token,
        refresh_token: "",
        token_type: "Bearer",
        expires_at: Date.now() / 1_000 + 3600,
        provider: "basic",
        user_id: code.identity,
      });
    }
    const identity = tokens.get((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
    assert.ok(identity, "The same-origin REST leg requires the native bearer.");
    if (route === "/api/auth/me")
      return json({ user_id: identity, provider: "basic", expires_at: Date.now() / 1_000 + 3600 });
    if (route === "/api/profiles")
      return json({ profiles: ["alpha", "beta", "default"].map((name) => ({ name, is_default: name === "default" })) });
    if (route === "/api/auth/ws-ticket") {
      ticketPosts++;
      if (rejectTickets) {
        response.statusCode = 401;
        return json({ detail: "remote-private-error-never-exported" });
      }
      if (ticketGate) {
        const gate = ticketGate;
        ticketGate = null;
        response.once("close", gate.closed.resolve);
        gate.reached.resolve();
        await gate.release.promise;
        if (response.destroyed) return;
      }
      const ticket = randomBytes(32).toString("base64url");
      secrets.add(ticket);
      tickets.set(ticket, { identity, expires: Date.now() + 30_000 });
      if (nextCertificate) {
        assert.ok("setSecureContext" in server);
        server.setSecureContext(nextCertificate);
        nextCertificate = null;
      }
      return json({ ticket, ttl_seconds: 30 });
    }
    throw new Error("Unexpected synthetic route");
  };
  const server = tls ? createSecureServer(tls, handler) : createServer(handler);
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => "hermes-gateway-v1" });
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.url, "/proxy/api/ws");
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((item) => item.trim());
    const value = protocols.find((item) => item.startsWith("hermes-gateway-ticket."))?.slice(22) ?? "";
    const ticket = tickets.get(value);
    tickets.delete(value);
    assert.ok(ticket && ticket.expires > Date.now(), "Each admission consumes a fresh unexpired ticket.");
    upgrades++;
    sockets.handleUpgrade(request, socket, head, (wire) => {
      const peer: Peer = { identity: ticket.identity, session: null, socket: wire };
      peers.add(peer);
      wire.on("close", () => peers.delete(peer));
      wire.on("message", (data) => {
        const input = Schema.decodeUnknownSync(Input)(JSON.parse(data.toString()));
        const method = input.method;
        if (!method) {
          const broadcast = broadcasts.get(input.id);
          if (input.error) rejectedRequests++;
          if (broadcast?.status === "pending") {
            broadcast.status = input.error ? "failed" : "resolved";
            broadcast.done.resolve();
          }
          return;
        }
        const params = input.params ?? {};
        const row = {
          identity: peer.identity,
          method,
          ...(params.profile === undefined ? {} : { profile: params.profile }),
          ...(params.session_id === undefined ? {} : { session: params.session_id }),
          ...(params.submission_id === undefined ? {} : { submission: params.submission_id }),
        };
        seen.push(row);
        const reply = (value: unknown) => wire.send(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: value }));
        const selected = next?.method === method ? next : null;
        if (selected) {
          next = null;
          selected.reached.resolve();
        }
        if (selected?.action === "hold") return;
        if (method === "runtime.describe") {
          assert.deepEqual(params, {}, "The pinned describe RPC refuses a profile selector.");
          return reply({
            instance_id: "synthetic-owner",
            profile_id: "/synthetic/default",
            authority_epoch: 1,
            capabilities: capabilities ? ["durable-admission-v1", "event-replay-v1"] : [],
          });
        }
        if (method === "client.capabilities") {
          assert.equal(params.desktop_local, false);
          assert.equal(params.server_requests, peer.identity === "broadcast-review" && params.server_requests === true);
          return reply({ server_requests: ["approval", "clarify", "sudo"] });
        }
        if (method === "gateway.ping") return reply({ ok: true });
        assert.ok(params.profile && params.session_id, "Every session RPC includes the explicit profile and session.");
        if (method === "session.resume") {
          assert.equal(params.omit_messages, true);
          const key = JSON.stringify([peer.identity, params.profile, params.session_id]);
          let session = sessions.get(key);
          if (!session) {
            session = {
              identity: peer.identity,
              profile: params.profile,
              id: params.session_id,
              home: `/synthetic/${peer.identity}/${params.profile}`,
              generation: 1,
              running: false,
              epoch: randomBytes(16).toString("hex"),
              sequence: 0,
              pending: [],
              prompts: [],
            };
            sessions.set(key, session);
          }
          peer.session = session;
          const snapshot = snapshotOf(session);
          if (selected?.action === "wrong-profile") snapshot.info.profile_name = "other";
          if (selected?.action === "wrong-session") snapshot.session_id = "other-session";
          if (selected?.action === "stage-event") emit(peer, "message.delta", { text: "during attach\n" });
          if (selected?.action === "reply-then-invalid") {
            wire.send(`${JSON.stringify({ jsonrpc: "2.0", id: input.id, result: snapshot })}\ninvalid-json`);
            return;
          }
          return reply(snapshot);
        }
        const session = peer.session;
        assert.ok(session && params.profile === session.profile && params.session_id === session.id);
        if (method === "prompt.submit") {
          assert.equal(params.queued, false);
          assert.equal(params.clarify_batch, false);
          assert.ok(params.submission_id && params.text);
          session.generation++;
          session.running = true;
          const receipt: Receipt = {
            admission_id: randomBytes(16).toString("hex"),
            ref: { profile_id: session.home, session_id: session.id },
            sequence: 1,
            status: "started",
            outcome: null,
            authority_epoch: 1,
            execution_generation: session.generation,
            input_id: params.submission_id,
          };
          session.pending = [receipt];
          if (selected?.action === "drop-running") {
            wire.terminate();
            return;
          }
          if (selected?.action === "drop") {
            session.running = false;
            session.pending = [];
            wire.terminate();
            return;
          }
          if (selected?.action === "wrong-ref")
            return reply({ ...receipt, ref: { ...receipt.ref, profile_id: "/other/profile" } });
          if (selected?.action === "complete-before-ack") {
            const frames = [
              event(peer, "message.start", {}),
              event(peer, "message.delta", { text: "early\n", turn_id: "early-turn", segment: 0, offset: 0 }),
              event(peer, "message.complete", { text: "early", status: "completed" }),
            ];
            session.running = false;
            session.pending = [];
            wire.send(frames.join("\n"));
            return reply(receipt);
          }
          reply(receipt);
          wire.send(
            [
              event(peer, "message.start", {}),
              event(peer, "message.delta", {
                text: `${peer.identity}/${session.profile}\n`,
                turn_id: receipt.admission_id,
                segment: 0,
                offset: 0,
              }),
            ].join("\n"),
          );
          return;
        }
        if (method === "approval.respond" || method === "clarify.respond") {
          const prompt = session.prompts.find((item) => item.prompt_id === params.prompt_id);
          assert.ok(prompt);
          assert.equal(params.execution_generation, prompt.execution_generation);
          assert.equal(params.execution_generation, session.generation);
          if (method === "approval.respond") assert.ok(prompt.choices.includes(params.choice ?? ""));
          session.prompts = session.prompts.filter((item) => item !== prompt);
          if (selected?.action === "drop") {
            wire.terminate();
            return;
          }
          reply({ status: "resolved", prompt_id: prompt.prompt_id });
          emit(peer, `${prompt.kind}.settled`, { prompt_id: prompt.prompt_id });
          return;
        }
        if (method === "session.interrupt") {
          assert.equal(params.execution_generation, session.generation);
          if (selected?.action === "drop") {
            wire.terminate();
            return;
          }
          session.running = false;
          session.prompts = [];
          const admission = session.pending[0]?.admission_id;
          const frame = event(
            peer,
            "message.complete",
            { text: "", status: "interrupted" },
            { ...(admission ? { admission_id: admission } : {}) },
          );
          session.pending = [];
          reply({
            ref: { profile_id: session.home, session_id: session.id },
            instance_id: "synthetic-owner",
            authority_epoch: 1,
            revision: 0,
            execution_generation: session.generation,
            execution_state: "idle",
          });
          wire.send(frame);
          return;
        }
        throw new Error(`Unexpected synthetic RPC ${method}`);
      });
      wire.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: {
            type: "gateway.ready",
            payload: { session_authority: authority, heartbeat: true, replay_epoch: "global-epoch" },
          },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `${tls ? "https" : "http"}://127.0.0.1:${address.port}`;
  function snapshotOf(session: Session) {
    return {
      session_id: session.id,
      stored_session_id: session.id,
      messages: [],
      messages_omitted: true,
      message_count: 0,
      running: session.running,
      authority_epoch: 1,
      replay_epoch: session.epoch,
      last_sequence: session.sequence,
      subscription_id: "synthetic-subscription",
      revision: 0,
      execution_generation: session.generation,
      pending: structuredClone(session.pending),
      prompts: structuredClone(session.prompts),
      info: {
        desktop_protocol: "hermes-gateway-v1",
        profile_id: session.home,
        profile_name: session.profile,
        api_key: "private-config-never-projected",
      },
    };
  }
  function event(
    peer: Peer,
    type: string,
    payload: unknown,
    overrides: {
      seq?: number;
      replay_epoch?: string;
      execution_generation?: number | undefined;
      session_id?: string;
      profile?: string;
      admission_id?: string;
    } = {},
  ) {
    const session = peer.session;
    assert.ok(session);
    session.sequence++;
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type,
        session_id: session.id,
        seq: session.sequence,
        replay_epoch: session.epoch,
        authority_epoch: 1,
        execution_generation: session.generation,
        ...(session.pending[0] ? { admission_id: session.pending[0].admission_id } : {}),
        payload,
        ...overrides,
      },
    });
  }
  function emit(peer: Peer, type: string, payload: unknown, overrides?: Parameters<typeof event>[3]) {
    peer.socket.send(event(peer, type, payload, overrides));
  }
  async function signIn(identity: string) {
    const connection = await Effect.runPromise(HermesGatewayConnection.create(`${origin}/proxy`));
    clients.push(connection);
    await Effect.runPromise(
      connection.signInBrowser("basic", async (address) => {
        const authorize = new URL(address);
        assert.equal(authorize.origin, origin);
        assert.equal(authorize.pathname, "/proxy/auth/native/authorize");
        const code = randomBytes(32).toString("base64url");
        secrets.add(code);
        codes.set(code, { identity, challenge: authorize.searchParams.get("code_challenge") ?? "" });
        const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        assert.equal(callback.hostname, "127.0.0.1");
        assert.equal(callback.protocol, "http:");
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        callback.searchParams.set("code", code);
        await new Promise<void>((resolve, reject) => {
          const request = get(callback, { agent: false }, (response) => {
            response.resume();
            response.on("end", () => {
              assert.equal(response.statusCode, 200);
              resolve();
            });
          });
          request.on("error", reject);
        });
      }),
    );
    return connection;
  }
  return {
    signIn,
    emit,
    event,
    seen,
    secrets,
    replaceCertificateOnTicket(certificate: { key: string; cert: string }) {
      nextCertificate = certificate;
    },
    get upgrades() {
      return upgrades;
    },
    get ticketPosts() {
      return ticketPosts;
    },
    get rejectedRequests() {
      return rejectedRequests;
    },
    broadcast(method: "sudo" | "secret" | "clarify", identity: string, profile: string, sessionId: string) {
      const id = `srq-${randomBytes(6).toString("hex")}`;
      const entry: { status: "pending" | "failed" | "resolved"; done: ReturnType<typeof deferred> } = {
        status: "pending",
        done: deferred(),
      };
      broadcasts.set(id, entry);
      const params =
        method === "sudo"
          ? { session_id: sessionId, command: "synthetic command" }
          : method === "secret"
            ? { session_id: sessionId, env_var: "SYNTHETIC_REVIEW_VALUE", prompt: "Synthetic value" }
            : {
                session_id: sessionId,
                questions: [
                  { qid: "q1", question: "Synthetic question", choices: ["one", "two"], multi_select: false },
                ],
              };
      for (const peer of peers)
        if (peer.identity === identity && peer.session?.profile === profile && peer.session.id === sessionId)
          peer.socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params,
            }),
          );
      return { id, state: () => entry.status, settled: entry.done.promise };
    },
    async capableViewer() {
      const identity = "broadcast-review";
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, { identity, expires: Date.now() + 30_000 });
      const socket = new WebSocket(
        `${origin.replace(/^http/u, "ws")}/proxy/api/ws`,
        ["hermes-gateway-v1", `hermes-gateway-ticket.${ticket}`],
        { origin },
      );
      const received = new Set<string>();
      const signals = new Map<string, ReturnType<typeof deferred>>();
      const replies = new Map<string, ReturnType<typeof deferred>>();
      socket.on("message", (data) => {
        const frame = Schema.decodeUnknownSync(
          Schema.Struct({ id: Schema.optionalKey(Schema.String), method: Schema.optionalKey(Schema.String) }),
        )(JSON.parse(data.toString()));
        if (!frame.id) return;
        if (frame.method) {
          received.add(frame.id);
          signals.get(frame.id)?.resolve();
        } else replies.get(frame.id)?.resolve();
      });
      await once(socket, "open");
      const call = async (
        method: string,
        params: {
          server_requests?: boolean;
          desktop_local?: boolean;
          profile?: string;
          session_id?: string;
          omit_messages?: boolean;
        },
      ) => {
        const id = randomBytes(16).toString("hex");
        const replied = deferred();
        replies.set(id, replied);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        await replied.promise;
        replies.delete(id);
      };
      await call("client.capabilities", { server_requests: true, desktop_local: false });
      await call("session.resume", { profile: "alpha", session_id: "shared-prompt", omit_messages: true });
      return {
        async observe(id: string) {
          if (received.has(id)) return;
          const signal = deferred();
          signals.set(id, signal);
          await signal.promise;
        },
        answer(id: string, method: "sudo" | "secret" | "clarify") {
          const result =
            method === "clarify"
              ? { answers: { q1: "one" }, outcome: "submitted" }
              : { value: "synthetic-explicit-value" };
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
        },
        async close() {
          const closed = once(socket, "close");
          socket.terminate();
          await closed;
        },
      };
    },
    setCapabilities(value: boolean) {
      capabilities = value;
    },
    setAuthority(value: boolean) {
      authority = value;
    },
    setRejectTickets(value: boolean) {
      rejectTickets = value;
    },
    action(method: string, action: Action) {
      const reached = deferred();
      next = { method, action, reached };
      return reached.promise;
    },
    holdTicket() {
      const reached = deferred();
      const release = deferred();
      const closed = deferred();
      ticketGate = { reached, release, closed };
      return { reached: reached.promise, release: release.resolve, closed: closed.promise };
    },
    peer(identity: string, profile: string) {
      const peer = [...peers].reverse().find((item) => item.identity === identity && item.session?.profile === profile);
      assert.ok(peer);
      return peer;
    },
    async close() {
      for (const peer of peers) peer.socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function failure<A, E extends { code: string }>(effect: Effect.Effect<A, E>, code?: string) {
  const result = await Effect.runPromise(Effect.result(effect));
  assert.ok(Result.isFailure(result), "Expected a fixed-code failure.");
  if (code) assert.equal(result.failure.code, code);
  assert.equal(Object.keys(result.failure).includes("cause"), false);
  return result.failure;
}

function localSessionMetadata(session: Session) {
  // Pinned gateway/session_local.py::local_session_info and
  // session_local_inventory.py::agent_inventory / publish_settled_info.
  return {
    source: "gui",
    model: "synthetic-model",
    lazy: false,
    profile_id: session.home,
    profile_name: session.profile,
    desktop_protocol: "hermes-gateway-v1",
    cwd: "/synthetic/workspace",
    reasoning_effort: "medium",
    reasoning_effort_wire: "medium",
    launch_request: { source: "gui" },
    title: "Synthetic session",
    started_at: 1,
    last_active_at: 2,
    yolo: false,
    api_mode: "chat_completions",
    tool_count: 1,
    credential_hint: null,
    provider: "synthetic-provider",
    tools: { terminal: ["terminal"] },
    system_prompt: "synthetic-private-inventory-not-projected",
    context_length: 4096,
  };
}

async function checkSessionInfoMetadata(gateway: Awaited<ReturnType<typeof fixture>>) {
  const owner = await gateway.signIn("metadata-review");
  const chat = await Effect.runPromise(owner.createChatTransport("alpha"));
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("metadata-review"));
  await Effect.runPromise(chat.submit("metadata review turn"));
  await Effect.runPromise(chat.readEvent());
  const peer = gateway.peer("metadata-review", "alpha");
  const session = peer.session;
  assert.ok(session);
  const prompt: Prompt = {
    kind: "approval",
    prompt_id: "metadata-approval",
    execution_generation: session.generation,
    choices: ["once", "deny"],
  };
  session.prompts = [prompt];
  gateway.emit(peer, "approval.request", prompt);
  await Effect.runPromise(chat.readEvent());
  const before = chat.state();
  gateway.emit(peer, "session.info", localSessionMetadata(session));
  gateway.emit(peer, "message.delta", { text: "metadata barrier\n" });
  const barrier = await Effect.runPromise(chat.readEvent());
  assert.ok(
    barrier.type === "delta" && barrier.text?.trim() === "metadata barrier",
    "Local settings metadata must not close an active canonical session.",
  );
  assert.deepEqual(
    chat.state(),
    before,
    "Settings metadata cannot clear running state, prompts or execution identity.",
  );
  assert.ok(!JSON.stringify(chat.state()).includes("synthetic-private-inventory-not-projected"));
  await Effect.runPromise(chat.respondApproval(prompt.prompt_id, "deny"));
  await Effect.runPromise(chat.readEvent());
  await Effect.runPromise(chat.interrupt());
  await Effect.runPromise(chat.readEvent());
  const upgrades = gateway.upgrades;
  gateway.emit(peer, "session.info", localSessionMetadata(session), { execution_generation: undefined });
  await Effect.runPromise(chat.attach("metadata-review"));
  assert.equal(gateway.upgrades, upgrades, "An end-of-turn metadata event cannot force a redial.");
  session.generation++;
  // Policy refresh publishes a complete control update followed by local settings metadata.
  gateway.emit(
    peer,
    "session.info",
    {
      desktop_protocol: "hermes-gateway-v1",
      authority_epoch: 1,
      execution_generation: session.generation,
      running: false,
      pending: [],
    },
    { execution_generation: undefined },
  );
  gateway.emit(
    peer,
    "session.info",
    { ...localSessionMetadata(session), lazy: true, model: null },
    { execution_generation: undefined },
  );
  gateway.emit(peer, "message.delta", { text: "policy barrier\n" });
  await Effect.runPromise(chat.readEvent());
  assert.equal(chat.state().generation, session.generation);
  assert.equal(chat.state().running, false);
  assert.equal(chat.state().prompts.length, 0);
  await failure(chat.respondApproval(prompt.prompt_id, "once"), "stale-prompt");
  chat.close();
  cases.push(
    "real local-session end-of-turn/settings and policy-refresh metadata preserve the socket and control state without exporting inventory",
  );
}

async function checkStrictSessionInfo(gateway: Awaited<ReturnType<typeof fixture>>) {
  const owner = await gateway.signIn("control-review");
  const chat = await Effect.runPromise(owner.createChatTransport("alpha"));
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("strict-info"));
  const session = gateway.peer("control-review", "alpha").session;
  assert.ok(session);
  const metadata = localSessionMetadata(session);
  const control = {
    desktop_protocol: "hermes-gateway-v1",
    authority_epoch: 1,
    execution_generation: session.generation,
    running: false,
    pending: [],
  };
  const invalid = [
    {
      desktop_protocol: "hermes-gateway-v1",
      authority_epoch: 1,
      execution_generation: session.generation,
      running: false,
    },
    { ...metadata, running: false },
    { ...control, running: "idle" },
    {
      ...control,
      pending: [
        {
          admission_id: "foreign-admission",
          input_id: "foreign-input",
          ref: { profile_id: "/foreign/profile", session_id: session.id },
          sequence: 1,
          status: "started",
          outcome: null,
          authority_epoch: 1,
          execution_generation: session.generation,
        },
      ],
    },
    { ...metadata, profile_id: "/foreign/profile" },
    { ...metadata, profile_name: "beta" },
    { ...control, profile_id: "/foreign/profile" },
  ];
  for (const payload of invalid) {
    if (chat.state().phase === "disconnected") {
      await Effect.runPromise(chat.connect());
      await Effect.runPromise(chat.attach("strict-info"));
    }
    const waiting = Effect.runPromise(Effect.result(chat.readEvent()));
    gateway.emit(gateway.peer("control-review", "alpha"), "session.info", payload);
    assert.ok(
      Result.isFailure(await waiting),
      "Malformed, partial or conflicting control/identity fields must close the transport.",
    );
    assert.equal(chat.state().phase, "disconnected");
  }
  chat.close();
  cases.push("partial/malformed control updates and metadata/control owner substitutions remain fail closed");
}

async function checkStreamSecrets(gateway: Awaited<ReturnType<typeof fixture>>, choiceOnly = false) {
  const owner = await gateway.signIn("stream-review");
  const chat = await Effect.runPromise(owner.createChatTransport("alpha"));
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("stream-review"));
  await Effect.runPromise(chat.submit("synthetic redaction review"));
  await Effect.runPromise(chat.readEvent());
  const peer = gateway.peer("stream-review", "alpha");
  const session = peer.session;
  assert.ok(session);
  const secret = `review-"value /+%\\line\n${randomBytes(16).toString("hex")}`;
  registerSecretValue(secret);
  const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  let displayed = "";
  for (const [index, form] of forms.entries()) {
    const prompt: Prompt = {
      kind: "clarify",
      prompt_id: `choice-review-${index}`,
      execution_generation: session.generation,
      question: "Synthetic question",
      choices: [secret, "safe choice"],
    };
    session.prompts = [prompt];
    const middle = Math.floor(form.length / 2);
    if (!choiceOnly)
      gateway.emit(peer, "message.delta", {
        text: form.slice(0, 4),
        turn_id: `redaction-${index}`,
        segment: 0,
        offset: 0,
      });
    gateway.emit(peer, "clarify.request", prompt);
    const card = await Effect.runPromise(chat.readEvent());
    assert.equal(
      card.type,
      "prompt",
      "A possible credential prefix must be held, not emitted before a later chunk completes it.",
    );
    assert.ok(card.type === "prompt");
    assert.ok(
      card.prompt.choices.every((choice) => !forms.some((value) => choice.includes(value))),
      "Choice labels must use registered-value redaction.",
    );
    assert.ok(
      chat
        .state()
        .prompts.every((item) => item.choices.every((choice) => !forms.some((value) => choice.includes(value)))),
    );
    if (choiceOnly) {
      chat.close();
      cases.push("choice labels mask registered credentials");
      return;
    }
    gateway.emit(peer, "message.delta", {
      text: form.slice(4, middle),
      turn_id: `redaction-${index}`,
      segment: 0,
      offset: 4,
    });
    gateway.emit(peer, "message.delta", {
      text: `${form.slice(middle)} done\n`,
      turn_id: `redaction-${index}`,
      segment: 0,
      offset: middle,
    });
    const delta = await Effect.runPromise(chat.readEvent());
    assert.ok(delta.type === "delta" && delta.text !== null);
    displayed += delta.text;
    assert.ok(
      forms.every((value) => !displayed.includes(value)),
      "Joined chunks must not reconstruct raw, JSON-escaped or URL-encoded credentials.",
    );
    assert.ok(!Object.hasOwn(delta, "offset"), "Raw offsets cannot describe redacted/coalesced output.");
  }
  gateway.emit(peer, "message.delta", { text: secret.slice(0, 4), turn_id: "boundary", segment: 0, offset: 0 });
  gateway.emit(peer, "message.complete", { text: secret, status: "completed" });
  session.running = false;
  session.pending = [];
  session.prompts = [];
  const tail = await Effect.runPromise(chat.readEvent());
  assert.ok(tail.type === "delta" && tail.text !== null);
  displayed += tail.text;
  const complete = await Effect.runPromise(chat.readEvent());
  assert.ok(complete.type === "complete" && forms.every((value) => !complete.text.includes(value)));
  assert.ok(forms.every((value) => !displayed.includes(value)));
  const left = "bounded-review-left";
  const right = "bounded-review-right";
  registerSecretValue(left + right);
  registerSecretValue(right + left);
  const longSecret = (left + right).repeat(1000);
  const overflow = Effect.runPromise(Effect.result(chat.readEvent()));
  gateway.emit(peer, "message.delta", {
    text: longSecret.slice(0, 32_768),
    turn_id: "overflow",
    segment: 0,
    offset: 0,
  });
  gateway.emit(peer, "message.delta", {
    text: longSecret.slice(32_768),
    turn_id: "overflow",
    segment: 0,
    offset: 32_768,
  });
  assert.ok(
    Result.isFailure(await overflow),
    "An oversized ambiguous secret prefix must stop the stream without exposing it.",
  );
  assert.equal(chat.state().phase, "disconnected");
  chat.close();
  cases.push(
    "registered raw/JSON/URL credentials split across chunks, choice labels and final partial prefixes are masked; ambiguous carry remains bounded",
  );
}

async function checkBroadcastViewers(gateway: Awaited<ReturnType<typeof fixture>>) {
  const owner = await gateway.signIn("broadcast-review");
  const chat = await Effect.runPromise(owner.createChatTransport("alpha"));
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("shared-prompt"));
  const capable = await gateway.capableViewer();
  try {
    for (const method of ["sudo", "secret", "clarify"] as const) {
      const prompt = gateway.broadcast(method, "broadcast-review", "alpha", "shared-prompt");
      await capable.observe(prompt.id);
      // The first reply proves this viewer received the earlier broadcast. The second RPC is
      // sent after any old client's error response, so the broker has observed that error too.
      await Effect.runPromise(chat.attach("shared-prompt"));
      await Effect.runPromise(chat.attach("shared-prompt"));
      assert.equal(
        prompt.state(),
        "pending",
        "An unsupported viewer must not authoritatively cancel a capable viewer's shared request.",
      );
      capable.answer(prompt.id, method);
      await prompt.settled;
      assert.equal(prompt.state(), "resolved");
    }
    assert.equal(gateway.rejectedRequests, 0);
  } finally {
    await capable.close();
    chat.close();
  }
  cases.push(
    "an unsupported viewer stays silent on shared sudo/secret/batch requests so a capable viewer can explicitly answer without global cancellation",
  );
}

async function checkUncertaintyChain(gateway: Awaited<ReturnType<typeof fixture>>) {
  const owner = await gateway.signIn("uncertainty-review");
  const chat = await Effect.runPromise(owner.createChatTransport("alpha"));
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("uncertainty-chain"));
  gateway.action("prompt.submit", "drop-running");
  await failure(chat.submit("synthetic uncertain turn"), "uncertain");
  const original = gateway.seen
    .filter((row) => row.method === "prompt.submit" && row.identity === "uncertainty-review")
    .at(-1)?.submission;
  assert.ok(original);
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("uncertainty-chain"));
  assert.equal(chat.state().running, true);
  gateway.action("session.interrupt", "drop");
  await failure(chat.interrupt(), "uncertain");
  assert.ok(
    JSON.stringify(chat.state().uncertain).includes(original),
    "A lost interrupt cannot replace the unresolved turn's identity.",
  );
  await Effect.runPromise(chat.connect());
  await Effect.runPromise(chat.attach("uncertainty-chain"));
  await Effect.runPromise(chat.interrupt());
  await Effect.runPromise(chat.readEvent());
  assert.equal(
    chat.state().uncertain.length,
    2,
    "Successful explicit cancellation does not erase either uncertain action.",
  );
  const stop = chat.state().uncertain.find((operation) => operation.method === "session.interrupt");
  assert.ok(stop);
  chat.acknowledgeUncertain(stop.id);
  await failure(chat.submit("cannot erase the earlier fence"), "uncertain");
  assert.ok(chat.state().uncertain.some((operation) => operation.id === original));
  chat.acknowledgeUncertain(original);
  assert.equal(chat.state().uncertain.length, 0);
  assert.equal(
    gateway.seen.filter((row) => row.identity === "uncertainty-review" && row.method === "prompt.submit").length,
    1,
    "Neither reconnect nor cancellation can replay the uncertain input.",
  );
  chat.close();
  cases.push(
    "lost submit plus lost interrupt retain independent fences; explicit generation-fenced cancellation stays available and acknowledging one cannot clear another",
  );
}

async function tlsChild() {
  const directory = process.argv[3];
  assert.ok(directory);
  const trusted = {
    key: await readFile(join(directory, "key.pem"), "utf8"),
    cert: await readFile(join(directory, "cert.pem"), "utf8"),
  };
  const gateway = await fixture(trusted);
  try {
    const connection = await gateway.signIn("tls-fixture");
    const chat = await Effect.runPromise(connection.createChatTransport("alpha"));
    gateway.replaceCertificateOnTicket({
      key: await readFile(join(directory, "other-key.pem"), "utf8"),
      cert: await readFile(join(directory, "other-cert.pem"), "utf8"),
    });
    const before = gateway.upgrades;
    await failure(chat.connect());
    assert.equal(
      gateway.upgrades,
      before,
      "The persistent WSS adapter rejects the changed untrusted certificate before the ticket header arrives.",
    );
    assert.equal(chat.state().phase, "disconnected");
    chat.close();
    // Machine-readable: synthetic TLS outcome only, never keys or ticket values.
    process.stdout.write(`${JSON.stringify({ tlsPassed: true })}\n`);
  } finally {
    for (const client of clients) await Effect.runPromise(client.dispose());
    await gateway.close();
  }
}

async function tlsCase() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-hermes-chat-tls-"));
  try {
    for (const prefix of ["", "other-"])
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=Hermes chat synthetic fixture",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          join(directory, `${prefix}key.pem`),
          "-out",
          join(directory, `${prefix}cert.pem`),
        ],
        { stdio: "ignore" },
      );
    // The fixture CA is trusted only in this synthetic child. No OS trust or network setting changes.
    const output = execFileSync(process.execPath, ["--import", "tsx", import.meta.filename, "--tls-child", directory], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, "cert.pem") },
      encoding: "utf8",
      stdio: "pipe",
    });
    Schema.decodeUnknownSync(Schema.Struct({ tlsPassed: Schema.Literal(true) }))(JSON.parse(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--tls-child") {
  await tlsChild();
  process.exit(0);
}
const reviewMode = process.argv[2];
if (reviewMode?.startsWith("--review-")) {
  const gateway = await fixture();
  try {
    if (reviewMode === "--review-session-info") await checkSessionInfoMetadata(gateway);
    else if (reviewMode === "--review-stream-secrets") await checkStreamSecrets(gateway);
    else if (reviewMode === "--review-choice-labels") await checkStreamSecrets(gateway, true);
    else if (reviewMode === "--review-broadcast") await checkBroadcastViewers(gateway);
    else if (reviewMode === "--review-uncertainty") await checkUncertaintyChain(gateway);
    else throw new Error("Unknown synthetic review mode");
    // Machine-readable: fixed regression outcome only.
    process.stdout.write(`${JSON.stringify({ reviewPassed: true, cases: cases.length })}\n`);
  } finally {
    for (const client of clients) await Effect.runPromise(client.dispose());
    await gateway.close();
  }
  process.exit(0);
}
const gateway = await fixture();
try {
  await checkSessionInfoMetadata(gateway);
  await checkStrictSessionInfo(gateway);
  await checkStreamSecrets(gateway);
  await checkBroadcastViewers(gateway);
  await checkUncertaintyChain(gateway);
  const alice = await gateway.signIn("alice");
  const bob = await gateway.signIn("bob");
  const alpha = await Effect.runPromise(alice.createChatTransport("alpha"));
  const beta = await Effect.runPromise(alice.createChatTransport("beta"));
  const bobAlpha = await Effect.runPromise(bob.createChatTransport("alpha"));
  for (const chat of [alpha, beta, bobAlpha]) {
    await Effect.runPromise(chat.connect());
    await Effect.runPromise(chat.attach("same-session"));
  }
  const alphaPeer = gateway.peer("alice", "alpha");
  const betaPeer = gateway.peer("alice", "beta");
  const bobPeer = gateway.peer("bob", "alpha");
  await failure(alice.createChatTransport(""), "profile");
  await failure(alice.createChatTransport("../alpha"), "profile");
  await failure(alice.createChatTransport("unlisted"), "profile");
  const third = await Effect.runPromise(alice.createChatTransport("default"));
  const fourth = await Effect.runPromise(alice.createChatTransport("default"));
  await failure(alice.createChatTransport("alpha"), "limit");
  third.close();
  fourth.close();
  assert.equal(
    alpha.state().phase,
    "attached",
    "Invalid selectors cannot clear other active sessions or fall back to default.",
  );
  for (const [chat, expected] of [
    [alpha, "alice/alpha"],
    [beta, "alice/beta"],
    [bobAlpha, "bob/alpha"],
  ] as const) {
    await Effect.runPromise(chat.submit("synthetic turn"));
    const delta = await Effect.runPromise(chat.readEvent());
    assert.ok(delta.type === "delta" && delta.text?.trim() === expected);
  }
  assert.equal(
    gateway.seen.filter((row) => row.method === "prompt.submit" && ["alice", "bob"].includes(row.identity)).length,
    3,
  );
  await failure(alpha.attach("another-session"), "session-mismatch");
  await failure(alpha.submit("overlap"), "busy");
  cases.push(
    "native auth, fresh header tickets, proxy routing, canonical capabilities, same-session profile/account isolation and coalesced streaming",
  );

  const session = alphaPeer.session;
  assert.ok(session);
  const approval: Prompt = {
    kind: "approval",
    prompt_id: "approve-1",
    execution_generation: session.generation,
    choices: ["once", "always", "deny"],
    command: "synthetic command",
  };
  session.prompts = [approval];
  gateway.emit(alphaPeer, "approval.request", approval);
  assert.equal((await Effect.runPromise(alpha.readEvent())).type, "prompt");
  const beforeResponses = gateway.seen.length;
  await failure(alpha.respondApproval("missing", "once"), "stale-prompt");
  await failure(alpha.respondApproval("approve-1", "always"), "invalid-input");
  assert.equal(gateway.seen.length, beforeResponses, "No default, stale or permanent approval is sent.");
  await Effect.runPromise(alpha.respondApproval("approve-1", "once"));
  assert.equal((await Effect.runPromise(alpha.readEvent())).type, "prompt-settled");
  await failure(alpha.respondApproval("approve-1", "once"), "stale-prompt");
  const clarify: Prompt = {
    kind: "clarify",
    prompt_id: "clarify-1",
    execution_generation: session.generation,
    choices: ["one", "two"],
    question: "Synthetic question",
  };
  session.prompts = [clarify];
  gateway.emit(alphaPeer, "clarify.request", clarify);
  await Effect.runPromise(alpha.readEvent());
  await Effect.runPromise(alpha.respondClarification("clarify-1", "one"));
  await Effect.runPromise(alpha.readEvent());
  const stale = { ...approval, prompt_id: "old-generation", execution_generation: session.generation - 1 };
  gateway.emit(alphaPeer, "approval.request", stale, { execution_generation: session.generation - 1 });
  const multi = { ...clarify, prompt_id: "multi", multi_select: true };
  session.prompts = [multi];
  gateway.emit(alphaPeer, "clarify.request", multi);
  const multiEvent = await Effect.runPromise(alpha.readEvent());
  assert.ok(multiEvent.type === "prompt" && multiEvent.prompt.prompt_id === "multi");
  await failure(alpha.respondClarification("multi", "one"), "invalid-input");
  await Effect.runPromise(alpha.interrupt());
  const completion = await Effect.runPromise(alpha.readEvent());
  assert.ok(completion.type === "complete" && completion.status === "interrupted");
  assert.equal(beta.state().running, true);
  assert.equal(bobAlpha.state().running, true);
  cases.push(
    "exact generation-fenced approval/clarification, explicit once/deny only, stale and multi-select refusal and isolated interrupt",
  );

  gateway.action("prompt.submit", "complete-before-ack");
  await Effect.runPromise(alpha.submit("completion races acknowledgement"));
  const earlyDelta = await Effect.runPromise(alpha.readEvent());
  const earlyComplete = await Effect.runPromise(alpha.readEvent());
  assert.ok(earlyDelta.type === "delta" && earlyDelta.text?.trim() === "early");
  assert.equal(earlyComplete.type, "complete");
  assert.equal(alpha.state().running, false);
  await Effect.runPromise(alpha.submit("can submit after early completion"));
  await Effect.runPromise(alpha.readEvent());
  await Effect.runPromise(alpha.interrupt());
  await Effect.runPromise(alpha.readEvent());
  const secret = [...gateway.secrets][0];
  assert.ok(secret);
  gateway.emit(alphaPeer, "message.delta", { text: `secret: ${secret}` });
  const redacted = await Effect.runPromise(alpha.readEvent());
  assert.ok(redacted.type === "delta" && !redacted.text?.includes(secret));
  const duplicate = gateway.event(alphaPeer, "message.delta", { text: "one chunk\n" });
  alphaPeer.socket.send(`${duplicate}\n${duplicate}`);
  gateway.emit(alphaPeer, "message.complete", { text: "final", status: "completed" });
  assert.equal((await Effect.runPromise(alpha.readEvent())).type, "delta");
  assert.equal((await Effect.runPromise(alpha.readEvent())).type, "complete");
  cases.push(
    "completion before admission acknowledgement, exact event deduplication and secret-redacted stream projections",
  );

  const countBeforeLost = gateway.seen.filter((row) => row.method === "prompt.submit").length;
  gateway.action("prompt.submit", "drop");
  await failure(alpha.submit("lost ack"), "uncertain");
  const uncertain = alpha.state().uncertain[0];
  assert.ok(uncertain);
  const beforeReconnect = gateway.ticketPosts;
  await Effect.runPromise(alpha.connect());
  assert.equal(gateway.ticketPosts, beforeReconnect + 1);
  await failure(alpha.submit("not attached"), "not-connected");
  await Effect.runPromise(alpha.attach("same-session"));
  await failure(alpha.submit("not acknowledged"), "uncertain");
  assert.equal(
    gateway.seen.filter((row) => row.method === "prompt.submit").length,
    countBeforeLost + 1,
    "Reconnect and snapshot never replay a turn.",
  );
  alpha.acknowledgeUncertain(uncertain.id);
  assert.equal(alpha.state().uncertain.length, 0);
  cases.push(
    "lost turn acknowledgement fences writes; explicit reconnect uses a fresh ticket, explicit snapshot and explicit uncertainty decision without replay",
  );

  const resumedPeer = gateway.peer("alice", "alpha");
  const resumedSession = resumedPeer.session;
  assert.ok(resumedSession);
  const replayedPrompt: Prompt = {
    kind: "approval",
    prompt_id: "lost-approval",
    execution_generation: resumedSession.generation,
    choices: ["once", "deny"],
  };
  resumedSession.prompts = [replayedPrompt];
  gateway.emit(resumedPeer, "approval.request", replayedPrompt);
  await Effect.runPromise(alpha.readEvent());
  const beforeApproval = gateway.seen.filter((row) => row.method === "approval.respond").length;
  gateway.action("approval.respond", "drop");
  await failure(alpha.respondApproval("lost-approval", "once"), "uncertain");
  const lostApproval = alpha.state().uncertain[0];
  assert.ok(lostApproval);
  resumedSession.prompts = [replayedPrompt];
  await Effect.runPromise(alpha.connect());
  await Effect.runPromise(alpha.attach("same-session"));
  alpha.acknowledgeUncertain(lostApproval.id);
  await failure(alpha.respondApproval("lost-approval", "once"), "stale-prompt");
  assert.equal(gateway.seen.filter((row) => row.method === "approval.respond").length, beforeApproval + 1);
  cases.push("uncertain approval is never retried, including a replayed prompt after explicit reconnection");

  alpha.disconnect();
  await Effect.runPromise(alpha.connect());
  gateway.action("session.resume", "stage-event");
  await Effect.runPromise(alpha.attach("same-session"));
  const staged = await Effect.runPromise(alpha.readEvent());
  assert.ok(staged.type === "delta" && staged.text?.trim() === "during attach");
  const active = gateway.peer("alice", "alpha");
  const close = once(active.socket, "close");
  gateway.emit(active, "message.delta", { text: "gap" }, { seq: (active.session?.sequence ?? 0) + 2 });
  await close;
  assert.equal(alpha.state().phase, "disconnected");
  await failure(alpha.readEvent(), "not-connected");
  cases.push(
    "events arriving during snapshot attach are ordered; sequence gaps close the socket and require explicit resnapshot",
  );

  await Effect.runPromise(alpha.connect());
  gateway.action("session.resume", "wrong-profile");
  await failure(alpha.attach("same-session"), "profile-mismatch");
  await Effect.runPromise(alpha.connect());
  gateway.action("session.resume", "wrong-session");
  await failure(alpha.attach("same-session"), "session-mismatch");
  await Effect.runPromise(alpha.connect());
  await Effect.runPromise(alpha.attach("same-session"));
  const mismatchPeer = gateway.peer("alice", "alpha");
  assert.ok(mismatchPeer.session);
  mismatchPeer.session.prompts = [];
  gateway.action("prompt.submit", "wrong-ref");
  await failure(alpha.submit("wrong receipt owner"), "uncertain");
  assert.ok(alpha.state().uncertain.length > 0);
  cases.push("profile/session snapshot substitution and wrong-profile admission receipts fail closed");

  alpha.close();
  const unsupported = await Effect.runPromise(alice.createChatTransport("alpha"));
  gateway.setCapabilities(false);
  await failure(unsupported.connect(), "unsupported-protocol");
  gateway.setCapabilities(true);
  gateway.setAuthority(false);
  await failure(unsupported.connect());
  gateway.setAuthority(true);
  unsupported.close();
  const cancelledDial = await Effect.runPromise(alice.createChatTransport("alpha"));
  const gate = gateway.holdTicket();
  const dialing = Effect.runPromise(Effect.result(cancelledDial.connect()));
  await gate.reached;
  const beforeCancelled = gateway.upgrades;
  cancelledDial.disconnect();
  await gate.closed;
  gate.release();
  const dialResult = await dialing;
  assert.ok(Result.isFailure(dialResult));
  assert.equal(gateway.upgrades, beforeCancelled, "Disconnect while minting cannot open a late socket.");
  assert.equal(beta.state().phase, "attached", "Cancelling a ticket request cannot sign out another profile.");
  cancelledDial.close();
  cases.push(
    "legacy/missing canonical capabilities refused; cancellation during ticket mint has no late socket or replay",
  );

  const bounded = await Effect.runPromise(alice.createChatTransport("alpha"));
  await Effect.runPromise(bounded.connect());
  await Effect.runPromise(bounded.attach("buffer-test"));
  const boundedPeer = gateway.peer("alice", "alpha");
  const bufferClosed = once(boundedPeer.socket, "close");
  for (let index = 0; index < 129; index++) gateway.emit(boundedPeer, "message.delta", { text: "unconsumed" });
  await bufferClosed;
  assert.equal(bounded.state().phase, "disconnected");
  await failure(bounded.readEvent(), "not-connected");
  bounded.close();

  const broken = await Effect.runPromise(alice.createChatTransport("alpha"));
  await Effect.runPromise(broken.connect());
  gateway.action("session.resume", "reply-then-invalid");
  await failure(broken.attach("protocol-errors"), "not-connected");
  assert.equal(
    broken.state().phase,
    "disconnected",
    "A response followed by a bad frame cannot resurrect an attachment.",
  );
  await Effect.runPromise(broken.connect());
  await Effect.runPromise(broken.attach("protocol-errors"));
  let brokenPeer = gateway.peer("alice", "alpha");
  gateway.emit(brokenPeer, "message.delta", { text: "wrong session" }, { session_id: "other-session" });
  // A foreign session consumes no watermark in this session. Reset the fixture's test sequence.
  assert.ok(brokenPeer.session);
  brokenPeer.session.sequence--;
  gateway.emit(brokenPeer, "message.delta", { text: "right session\n" });
  const right = await Effect.runPromise(broken.readEvent());
  assert.ok(right.type === "delta" && right.text?.trim() === "right session");
  const foreign = Effect.runPromise(Effect.result(broken.readEvent()));
  gateway.emit(brokenPeer, "message.delta", { text: "foreign profile" }, { profile: "beta" });
  assert.ok(Result.isFailure(await foreign));
  assert.equal(broken.state().phase, "disconnected");
  await Effect.runPromise(broken.connect());
  await Effect.runPromise(broken.attach("protocol-errors"));
  brokenPeer = gateway.peer("alice", "alpha");
  const editFailure = Effect.runPromise(Effect.result(broken.readEvent()));
  gateway.emit(brokenPeer, "approval.request", {
    prompt_id: "unsupported-edit",
    execution_generation: brokenPeer.session?.generation,
    choices: ["once", "deny"],
    edit: { path: "/synthetic/private", content: "unsupported" },
  });
  assert.ok(Result.isFailure(await editFailure));
  await Effect.runPromise(broken.connect());
  await Effect.runPromise(broken.attach("protocol-errors"));
  brokenPeer = gateway.peer("alice", "alpha");
  const binaryFailure = Effect.runPromise(Effect.result(broken.readEvent()));
  brokenPeer.socket.send(Buffer.from("binary"), { binary: true });
  assert.ok(Result.isFailure(await binaryFailure));
  broken.close();
  cases.push(
    "bad-frame-after-snapshot race, foreign session/profile frames, unsupported edit approvals and binary frames fail closed without stale attachment",
  );

  const updates = await Effect.runPromise(alice.createChatTransport("alpha"));
  await Effect.runPromise(updates.connect());
  await Effect.runPromise(updates.attach("owner-updates"));
  const updatesPeer = gateway.peer("alice", "alpha");
  const updatesSession = updatesPeer.session;
  assert.ok(updatesSession);
  updatesSession.generation++;
  updatesSession.running = true;
  gateway.emit(
    updatesPeer,
    "session.info",
    {
      desktop_protocol: "hermes-gateway-v1",
      authority_epoch: 1,
      execution_generation: updatesSession.generation,
      running: true,
      pending: [],
    },
    { execution_generation: undefined },
  );
  gateway.emit(
    updatesPeer,
    "approval.request",
    { ...approval, prompt_id: "outdated-info-prompt", execution_generation: updatesSession.generation - 1 },
    { execution_generation: updatesSession.generation - 1 },
  );
  const currentPrompt = {
    ...approval,
    prompt_id: "updated-owner-prompt",
    execution_generation: updatesSession.generation,
  };
  updatesSession.prompts = [currentPrompt];
  gateway.emit(updatesPeer, "approval.request", currentPrompt);
  const currentEvent = await Effect.runPromise(updates.readEvent());
  assert.ok(currentEvent.type === "prompt" && currentEvent.prompt.prompt_id === "updated-owner-prompt");
  gateway.emit(
    updatesPeer,
    "message.complete",
    { text: "", outcome: "cancelled" },
    { execution_generation: undefined, admission_id: "other-queued-row" },
  );
  await Effect.runPromise(updates.respondApproval("updated-owner-prompt", "deny"));
  assert.equal((await Effect.runPromise(updates.readEvent())).type, "prompt-settled");
  assert.equal(updates.state().running, true, "A generationless queued completion cannot end another execution.");
  await Effect.runPromise(updates.interrupt());
  await Effect.runPromise(updates.readEvent());
  updates.close();
  cases.push(
    "payload-only owner generation updates fence stale controls; queued cancellation cannot end or approve a different running turn",
  );

  const aborted = await Effect.runPromise(alice.createChatTransport("alpha"));
  await Effect.runPromise(aborted.connect());
  await Effect.runPromise(aborted.attach("cancel-submit"));
  const submissionRead = gateway.action("prompt.submit", "hold");
  const abortSubmission = new AbortController();
  const pendingSubmit = Effect.runPromise(aborted.submit("cancel uncertain submission"), {
    signal: abortSubmission.signal,
  });
  await submissionRead;
  abortSubmission.abort();
  await assert.rejects(pendingSubmit);
  assert.equal(aborted.state().phase, "disconnected");
  assert.equal(aborted.state().uncertain[0]?.method, "prompt.submit");
  aborted.close();
  cases.push(
    "cancelling an in-flight submitted request closes its socket and retains uncertainty instead of assuming remote cancellation",
  );

  const charlie = await gateway.signIn("charlie");
  const refused = await Effect.runPromise(charlie.createChatTransport("alpha"));
  const sibling = await Effect.runPromise(charlie.createChatTransport("beta"));
  for (const chat of [refused, sibling]) {
    await Effect.runPromise(chat.connect());
    await Effect.runPromise(chat.attach("auth-refusal"));
  }
  refused.disconnect();
  gateway.setRejectTickets(true);
  const authError = await failure(refused.connect());
  assert.ok(!JSON.stringify(authError).includes("remote-private-error-never-exported"));
  gateway.setRejectTickets(false);
  assert.equal(refused.state().phase, "closed");
  assert.equal(sibling.state().phase, "closed", "A native authentication refusal invalidates that account owner.");
  assert.equal(beta.state().phase, "attached");
  assert.equal(bobAlpha.state().phase, "attached");
  cases.push("authentication refusal closes only its account transports and exports no remote response body");
  const readCancellation = new AbortController();
  const waiting = Effect.runPromise(beta.readEvent(), { signal: readCancellation.signal });
  readCancellation.abort();
  await assert.rejects(waiting);
  assert.equal(beta.state().phase, "attached", "Cancelling a read does not interrupt the remote turn.");
  alice.close();
  assert.equal(beta.state().phase, "closed");
  assert.equal(bobAlpha.state().phase, "attached", "Local sign-out cannot close another account.");
  const owner = new AbortController();
  const expired = new HermesGatewayChatTransport({
    base: new URL("http://127.0.0.1"),
    profile: "alpha",
    owner: owner.signal,
    expiresAt: Date.now() - 1,
    mintTicket: Effect.succeed("never-used-synthetic-ticket"),
    onClose: () => {},
  });
  assert.equal(expired.state().phase, "closed");
  await failure(expired.connect(), "closed");
  for (const secret of gateway.secrets) assert.ok(!redactText(secret).includes(secret));
  cases.push(
    "bounded slow-consumer queue, read cancellation, token-expiry closure and account-isolated owner teardown",
  );

  assert.ok(betaPeer.identity === "alice" && bobPeer.identity === "bob");
  await tlsCase();
  cases.push(
    "persistent WSS rejects an untrusted replacement certificate after trusted native REST auth, before sending its ticket",
  );
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(
    resolve(OUTPUT, "report.json"),
    `${JSON.stringify({ passed: true, cases, rpcCounts: Object.fromEntries([...new Set(gateway.seen.map((row) => row.method))].map((method) => [method, gateway.seen.filter((row) => row.method === method).length])) }, null, 2)}\n`,
  );
  passed = true;
  // Machine-readable: fixed case names and counts only. No transcript, credentials or remote errors.
  process.stdout.write(`${JSON.stringify({ passed: true, cases: cases.length })}\n`);
} finally {
  for (const client of clients) await Effect.runPromise(client.dispose());
  await gateway.close();
  if (!passed) {
    await mkdir(OUTPUT, { recursive: true });
    await writeFile(resolve(OUTPUT, "report.json"), `${JSON.stringify({ passed: false, cases }, null, 2)}\n`);
  }
}
