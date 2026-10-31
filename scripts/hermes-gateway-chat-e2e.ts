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
import { redactText } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { type WebSocket, WebSocketServer } from "ws";
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
  const requestDeclined = deferred();
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
          assert.equal(input.error?.code, -32601);
          rejectedRequests++;
          requestDeclined.resolve();
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
          assert.deepEqual(params, { server_requests: false, desktop_local: false });
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
          if (selected?.action === "stage-event") emit(peer, "message.delta", { text: "during attach" });
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
              event(peer, "message.delta", { text: "early", turn_id: "early-turn", segment: 0, offset: 0 }),
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
                text: `${peer.identity}/${session.profile}`,
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
    requestDeclined: requestDeclined.promise,
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
      const peer = [...peers].find((item) => item.identity === identity && item.session?.profile === profile);
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
const gateway = await fixture();
try {
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
    assert.ok(delta.type === "delta" && delta.text === expected);
  }
  assert.equal(gateway.seen.filter((row) => row.method === "prompt.submit").length, 3);
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
  alphaPeer.socket.send(
    JSON.stringify({ jsonrpc: "2.0", id: "unsupported-sudo", method: "sudo", params: { password: "never-echo" } }),
  );
  await gateway.requestDeclined;
  await Effect.runPromise(alpha.interrupt());
  const completion = await Effect.runPromise(alpha.readEvent());
  assert.ok(completion.type === "complete" && completion.status === "interrupted");
  assert.equal(gateway.rejectedRequests, 1);
  assert.equal(beta.state().running, true);
  assert.equal(bobAlpha.state().running, true);
  cases.push(
    "exact generation-fenced approval/clarification, explicit once/deny only, stale and multi-select refusal, server-request decline and isolated interrupt",
  );

  gateway.action("prompt.submit", "complete-before-ack");
  await Effect.runPromise(alpha.submit("completion races acknowledgement"));
  const earlyDelta = await Effect.runPromise(alpha.readEvent());
  const earlyComplete = await Effect.runPromise(alpha.readEvent());
  assert.ok(earlyDelta.type === "delta" && earlyDelta.text === "early");
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
  const duplicate = gateway.event(alphaPeer, "message.delta", { text: "one chunk" });
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
  const uncertain = alpha.state().uncertain;
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
  assert.equal(alpha.state().uncertain, null);
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
  const lostApproval = alpha.state().uncertain;
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
  assert.ok(staged.type === "delta" && staged.text === "during attach");
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
  assert.ok(alpha.state().uncertain);
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
  gateway.emit(brokenPeer, "message.delta", { text: "right session" });
  const right = await Effect.runPromise(broken.readEvent());
  assert.ok(right.type === "delta" && right.text === "right session");
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
  assert.equal(aborted.state().uncertain?.method, "prompt.submit");
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
