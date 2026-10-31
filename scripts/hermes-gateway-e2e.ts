// Synthetic end-to-end checks of the real main-process adapter. No user gateway or app profile.
// Run: node --import tsx scripts/hermes-gateway-e2e.ts
// Report: .openbot-build/hermes-gateway-e2e/report.json
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactText } from "@openbot/logging";
import { Effect, Result } from "effect";
import { WebSocketServer } from "ws";
import { HermesGatewayConnection } from "../src/main/hermes-gateway-connection";
import type { HermesGatewayFailure } from "../src/main/hermes-gateway-protocol";

import {
  checkCookieSocketFailures,
  checkCookieSuffixRedaction,
  checkQuotedCookieLifecycle,
  checkRejectedCookieRedaction,
} from "./hermes-gateway-cookie-fixture";

const PASSWORD = "synthetic-password-only";
const OUT = resolve(import.meta.dirname, "../.openbot-build/hermes-gateway-e2e");
const checks: string[] = [];
const clients: HermesGatewayConnection[] = [];

type FixtureResponse =
  | { auth_required: boolean; secret: string }
  | { providers: { name: string; display_name: string; supports_password: boolean }[] }
  | { detail: string }
  | { ok: true; next: string; secret: string }
  | { user_id: string; provider: string; expires_at: number; private: string }
  | { profiles: { name: string; display_name: string; is_default: boolean; path: string; env: string }[] }
  | { ticket: string; ttl_seconds: number }
  | { error: string; reason?: string };

interface Seen {
  path: string;
  cookie: string;
  authorization: string;
  body: string;
}
interface FixtureOptions {
  tls?: { key: string; cert: string };
  tlsSocket?: { key: string; cert: string };
  authRequired?: boolean;
  passwordProvider?: boolean;
  redirect?: { route: string; target: string; code: number };
  fail?: { route: string; status: number; body?: string };
  cookie?: string;
  rejectSocket?: boolean;
  dropLogin?: boolean;
  onLogin?: () => Promise<void>;
}

async function fixture(options: FixtureOptions = {}) {
  const seen: Seen[] = [];
  const sessions = new Map<string, string>();
  const tickets = new Set<string>();
  const issuedTickets: string[] = [];
  let messages = 0;
  let upgrades = 0;
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const path = request.url ?? "";
    seen.push({ path, cookie: request.headers.cookie ?? "", authorization: request.headers.authorization ?? "", body });
    const route = path.replace(/^\/hermes/u, "");
    if (options.redirect?.route === route) {
      response.writeHead(options.redirect.code, { location: options.redirect.target }).end();
      return;
    }
    if (options.fail?.route === route) {
      response.writeHead(options.fail.status, { "content-type": "application/json" });
      response.end(options.fail.body ?? JSON.stringify({ detail: PASSWORD }));
      return;
    }
    const json = (value: FixtureResponse) => response.end(JSON.stringify(value));
    response.setHeader("content-type", "application/json");
    if (route === "/api/status") {
      response.setHeader(
        "set-cookie",
        "hermes_session_at=discovery-must-not-set-session; Path=/; HttpOnly; Max-Age=3600",
      );
      json({ auth_required: options.authRequired ?? true, secret: PASSWORD });
      return;
    }
    if (route === "/api/auth/providers") {
      json({
        providers: [
          { name: "basic", display_name: "Password", supports_password: options.passwordProvider ?? true },
          { name: "nous", display_name: "Nous", supports_password: false },
        ],
      });
      return;
    }
    if (route === "/auth/password-login") {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined, "A new login does not use the previous identity.");
      const input = JSON.parse(body);
      await options.onLogin?.();
      if (options.dropLogin) {
        request.socket.destroy();
        return;
      }
      if (input.password !== PASSWORD || input.provider !== "basic") {
        response.writeHead(401);
        json({ detail: PASSWORD });
        return;
      }
      const session = randomBytes(16).toString("hex");
      sessions.set(session, input.username);
      const secure = options.tls ? "Secure; " : "";
      const name = options.tls ? "__Secure-hermes_session_at" : "hermes_session_at";
      response.setHeader(
        "set-cookie",
        options.cookie?.replaceAll("{session}", session) ??
          `${name}=${session}; Path=/hermes; ${secure}HttpOnly; Max-Age=3600`,
      );
      json({ ok: true, next: "https://never-follow.invalid/", secret: PASSWORD });
      return;
    }
    const session = request.headers.cookie?.match(/(?:^|; )(?:(?:__Secure-)?hermes_session_at)=([^;]+)/u)?.[1];
    const identity = session ? sessions.get(session) : undefined;
    if (!identity) {
      response.writeHead(401);
      json({ error: "unauthenticated", reason: "fixture" });
      return;
    }
    if (route === "/api/auth/me") {
      // Rotate the cookie to prove that authenticated REST responses update this connection only.
      const rotated = randomBytes(16).toString("hex");
      sessions.set(rotated, identity);
      sessions.delete(session ?? "");
      const name = options.tls ? "__Secure-hermes_session_at" : "hermes_session_at";
      response.setHeader(
        "set-cookie",
        `${name}=${rotated}; Path=/hermes; ${options.tls ? "Secure; " : ""}HttpOnly; Max-Age=3600`,
      );
      json({ user_id: identity, provider: "basic", expires_at: Date.now() / 1_000 + 3600, private: PASSWORD });
      return;
    }
    if (route === "/api/profiles") {
      json({
        profiles: [
          {
            name: `${identity}-profile`,
            display_name: identity,
            is_default: true,
            path: "/private/home",
            env: PASSWORD,
          },
        ],
      });
      return;
    }
    if (route === "/api/auth/ws-ticket") {
      assert.equal(request.method, "POST");
      const ticket = randomBytes(32).toString("base64url");
      tickets.add(ticket);
      issuedTickets.push(ticket);
      if (options.tlsSocket && "setSecureContext" in server) server.setSecureContext(options.tlsSocket);
      json({ ticket, ttl_seconds: 30 });
      return;
    }
    response.writeHead(404);
    json({ error: "unexpected route" });
  };
  const server = options.tls ? createSecureServer(options.tls, handler) : createServer(handler);
  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("hermes-gateway-v1") ? "hermes-gateway-v1" : false),
  });
  server.on("upgrade", (request, socket, head) => {
    upgrades += 1;
    assert.equal(request.url, "/hermes/api/ws", "No secret, profile or identity is in the socket URL.");
    assert.equal(request.headers.cookie, undefined, "Only the single-use ticket authenticates the socket.");
    assert.equal(request.headers.authorization, undefined);
    const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
    const ticket = protocols.find((value) => value.startsWith("hermes-gateway-ticket."))?.slice(22) ?? "";
    if (options.rejectSocket || !tickets.delete(ticket)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("message", () => {
        messages += 1;
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/hermes`,
    seen,
    issuedTickets,
    get messages() {
      return messages;
    },
    get upgrades() {
      return upgrades;
    },
    close: async () => {
      for (const connection of sockets.clients) connection.terminate();
      sockets.close();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

async function connect(url: string) {
  const client = await Effect.runPromise(HermesGatewayConnection.create(url));
  clients.push(client);
  return client;
}

async function failure<A>(effect: Effect.Effect<A, HermesGatewayFailure>, code: HermesGatewayFailure["code"]) {
  const result = await Effect.runPromise(Effect.result(effect));
  assert.ok(Result.isFailure(result), `Expected failure: ${code}`);
  assert.equal(result.failure.code, code);
  assert.ok(!JSON.stringify(result.failure).includes(PASSWORD), "Public failures contain no remote data or password.");
  assert.equal(result.failure.cause, undefined);
}

async function withFixture(
  options: FixtureOptions,
  work: (gateway: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const gateway = await fixture(options);
  try {
    await work(gateway);
  } finally {
    await gateway.close();
  }
}

async function main() {
  await withFixture({}, async (gateway) => {
    const alice = await connect(gateway.url);
    const bob = await connect(gateway.url);
    const probe = await Effect.runPromise(alice.probe());
    assert.equal(probe.providers.length, 2);
    assert.equal(probe.oauth, "unavailable");
    const signedIn = await Effect.runPromise(alice.signInPassword("basic", "alice", PASSWORD));
    assert.deepEqual(signedIn, {
      profiles: [{ name: "alice-profile", display_name: "alice", is_default: true }],
      socket: "verified",
      chat: "unavailable",
    });
    await Effect.runPromise(bob.signInPassword("basic", "bob", PASSWORD));
    assert.equal((await Effect.runPromise(alice.listProfiles()))[0]?.name, "alice-profile");
    assert.equal((await Effect.runPromise(bob.listProfiles()))[0]?.name, "bob-profile");
    assert.equal(gateway.upgrades, 2);
    assert.equal(gateway.messages, 0, "No RPC, turn or approval is sent.");
    assert.ok(!redactText(PASSWORD).includes(PASSWORD));
    for (const ticket of gateway.issuedTickets) assert.ok(!redactText(ticket).includes(ticket));
    for (const request of gateway.seen) {
      for (const pair of request.cookie.split("; ").filter(Boolean)) {
        const value = pair.slice(pair.indexOf("=") + 1);
        assert.ok(!redactText(value).includes(value));
      }
    }
    assert.ok(
      gateway.seen.filter((request) => request.path.endsWith("/api/status")).every((request) => !request.cookie),
    );
    assert.ok(gateway.seen.every((request) => !request.authorization && !request.path.includes(PASSWORD)));
    alice.close();
    const count = gateway.seen.length;
    await failure(alice.listProfiles(), "closed");
    assert.equal(gateway.seen.length, count);
    assert.equal((await Effect.runPromise(bob.listProfiles()))[0]?.name, "bob-profile");
    const reconnected = await connect(gateway.url);
    await failure(reconnected.listProfiles(), "authentication");
    await Effect.runPromise(reconnected.signInPassword("basic", "alice", PASSWORD));
  });
  checks.push("password cookie login, rotation, provider discovery, profile projection, socket header ticket, no chat");
  checks.push("same-address identity isolation, local sign-out, explicit reconnect without saved credentials");

  for (const [options, code] of [
    [{ authRequired: false }, "unsupported-auth"],
    [{ passwordProvider: false }, "unsupported-auth"],
    [{ fail: { route: "/auth/password-login", status: 429 } }, "rate-limited"],
    [{ fail: { route: "/api/auth/me", status: 401 } }, "authentication"],
    [{ rejectSocket: true }, "socket-rejected"],
    [{ dropLogin: true }, "transport"],
    [{ fail: { route: "/api/profiles", status: 200, body: '{"profiles":[{"name":123}]}' } }, "invalid-response"],
    [{ fail: { route: "/api/profiles", status: 200, body: "x".repeat(1_048_577) } }, "invalid-response"],
    [{ cookie: "hermes_session_at={session}; Path=/other; HttpOnly; Max-Age=3600" }, "authentication"],
    [
      { cookie: "hermes_session_at={session}; Domain=127.0.0.1; Path=/hermes; HttpOnly; Max-Age=3600" },
      "authentication",
    ],
    [{ cookie: "hermes_session_at={session}; Path=/hermes; HttpOnly; Max-Age=0" }, "authentication"],
    [{ cookie: "hermes_session_at={session}; Path=/hermes; Max-Age=3600" }, "authentication"],
    [
      {
        fail: {
          route: "/api/auth/ws-ticket",
          status: 200,
          body: '{"ticket":"valid-shape-but-expired","ttl_seconds":0}',
        },
      },
      "invalid-response",
    ],
  ] satisfies [FixtureOptions, HermesGatewayFailure["code"]][]) {
    await withFixture(options, async (gateway) => {
      const client = await connect(gateway.url);
      await failure(client.signInPassword("basic", "alice", PASSWORD), code);
      const count = gateway.seen.length;
      await failure(client.listProfiles(), "authentication");
      assert.equal(gateway.seen.length, count, "A failed login retains no usable session.");
      assert.ok(gateway.seen.filter((request) => request.path.endsWith("/auth/password-login")).length <= 1);
    });
  }
  checks.push(
    "rate limit, rejected auth, socket rejection, uncertain login, malformed/oversized response, invalid cookies",
  );

  await withFixture({}, async (gateway) => {
    const client = await connect(gateway.url);
    await failure(client.signInPassword("basic", "alice", "wrong"), "authentication");
    assert.equal(gateway.seen.filter((request) => request.path.endsWith("/auth/password-login")).length, 1);
    await failure(client.signInPassword("nous", "alice", PASSWORD), "unsupported-auth");
  });
  checks.push("wrong password has no retry; OAuth cannot be used as password auth");

  const expiry: FixtureOptions = {};
  await withFixture(expiry, async (gateway) => {
    const client = await connect(gateway.url);
    await Effect.runPromise(client.signInPassword("basic", "alice", PASSWORD));
    expiry.fail = { route: "/api/profiles", status: 401 };
    await failure(client.listProfiles(), "authentication");
    const count = gateway.seen.length;
    await failure(client.listProfiles(), "authentication");
    assert.equal(gateway.seen.length, count, "An expired session is cleared without silent re-login or replay.");
  });
  checks.push("expiry clears authentication and requires explicit sign-in");

  await withFixture({}, async (sink) => {
    for (const status of [302, 307, 308]) {
      for (const route of ["/api/status", "/auth/password-login", "/api/profiles"]) {
        await withFixture({ redirect: { route, target: `${sink.url}/capture`, code: status } }, async (gateway) => {
          const client = await connect(gateway.url);
          await failure(client.signInPassword("basic", "alice", PASSWORD), "redirect");
        });
      }
    }
    assert.equal(sink.seen.length, 0, "Redirects never forward passwords or cookies, including 307/308.");
  });
  checks.push("discovery, credential POST and authenticated GET redirects fail closed; no credential forwarding");

  let enteredLogin: () => void = () => {};
  let releaseLogin: () => void = () => {};
  const entered = new Promise<void>((done) => {
    enteredLogin = done;
  });
  const released = new Promise<void>((done) => {
    releaseLogin = done;
  });
  await withFixture(
    {
      onLogin: () => {
        enteredLogin();
        return released;
      },
    },
    async (gateway) => {
      const client = await connect(gateway.url);
      const signingIn = failure(client.signInPassword("basic", "alice", PASSWORD), "closed");
      await entered;
      client.close();
      releaseLogin();
      await signingIn;
      await failure(client.probe(), "closed");
      assert.equal(gateway.upgrades, 0);
    },
  );
  checks.push("close during login aborts requests and cannot publish a stale session");

  for (const address of ["http://192.168.1.2:9119", "http://100.64.0.1:9119", "http://example.com"]) {
    await failure(HermesGatewayConnection.create(address), "tls-required");
  }
  for (const address of [
    "http://user:secret@127.0.0.1",
    "https://example.com?token=secret",
    "https://example.com/#secret",
    "https://example.com/%2fhermes",
    "https://example.com/../hermes",
    "https://example.com\\hermes",
    "127.0.0.1:9119",
  ]) {
    await failure(HermesGatewayConnection.create(address), "invalid-address");
  }
  checks.push("remote HTTP, credentials, queries, fragments and ambiguous gateway paths refused before network I/O");
}

async function tlsChecks() {
  const folder = await mkdtemp(join(tmpdir(), "openbot-hermes-tls-"));
  try {
    const key = join(folder, "key.pem");
    const cert = join(folder, "cert.pem");
    const untrustedKey = join(folder, "untrusted-key.pem");
    const untrustedCert = join(folder, "untrusted-cert.pem");
    for (const [privateKey, certificate] of [
      [key, cert],
      [untrustedKey, untrustedCert],
    ] as const)
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
          "/CN=Hermes synthetic fixture",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          privateKey,
          "-out",
          certificate,
        ],
        { stdio: "ignore" },
      );
    const tls = { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
    await withFixture({ tls }, async (gateway) => {
      const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      try {
        const client = await connect(gateway.url);
        await failure(client.probe(), "transport");
        assert.equal(gateway.seen.length, 0, "An untrusted certificate is refused even with a process TLS bypass.");
      } finally {
        if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      }
      // Node loads this fixture CA at process startup. This changes only the synthetic child process.
      execFileSync(
        "node",
        ["--import", "tsx", import.meta.filename, "--trusted-tls", key, cert, untrustedKey, untrustedCert],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
          stdio: "pipe",
        },
      );
    });
    checks.push(
      "untrusted HTTPS and WSS certificates rejected; trusted Secure/Host cookie lifecycles and proxy Origin pass",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function trustedTlsChild() {
  const key = process.argv[3];
  const cert = process.argv[4];
  assert.ok(key && cert);
  const tls = { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
  await checkQuotedCookieLifecycle(tls);
  await checkQuotedCookieLifecycle(tls, "");
  await checkRejectedCookieRedaction(tls);
  await checkCookieSuffixRedaction(tls);
  await checkCookieSuffixRedaction(tls, "");
  const untrustedKey = process.argv[5];
  const untrustedCert = process.argv[6];
  assert.ok(untrustedKey && untrustedCert);
  await withFixture(
    { tls, tlsSocket: { key: await readFile(untrustedKey, "utf8"), cert: await readFile(untrustedCert, "utf8") } },
    async (gateway) => {
      const client = await connect(gateway.url);
      await failure(client.signInPassword("basic", "tls", PASSWORD), "socket-rejected");
      assert.ok(
        gateway.seen.some((request) => request.path.endsWith("/api/auth/ws-ticket")),
        "Trusted REST login completed.",
      );
      assert.ok(gateway.upgrades === 0, "The WSS certificate was rejected before sending the ticket header.");
    },
  );
}

try {
  if (process.argv[2] === "--cookie-quoted") await checkQuotedCookieLifecycle();
  else if (process.argv[2] === "--cookie-suffix") await checkCookieSuffixRedaction();
  else if (process.argv[2] === "--cookie-rejected") await checkRejectedCookieRedaction();
  else if (process.argv[2] === "--trusted-tls") await trustedTlsChild();
  else {
    await checkQuotedCookieLifecycle();
    checks.push(
      "quoted padded AT/RT raw and wire redaction; full suffixed cookie set; concurrent account and refresh isolation",
    );
    await checkCookieSuffixRedaction();
    checks.push("anchored cookie roles prevent adversarial suffixes from bypassing token redaction or minimum length");
    await checkRejectedCookieRedaction();
    checks.push("rejected and short cookies and nonsecret provider hints cannot poison global redaction");
    await checkCookieSocketFailures();
    checks.push("expired ticket and interrupted socket admission have no replay or reconnect");
    await main();
    await tlsChecks();
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed: true, checks }, null, 2)}\n`);
    // Machine-readable: only fixed check descriptions; no gateway responses or credentials.
    process.stdout.write(
      `${JSON.stringify({ passed: true, checks: checks.length, report: "hermes-gateway-e2e/report.json" })}\n`,
    );
  }
} finally {
  for (const client of clients) client.close();
}
