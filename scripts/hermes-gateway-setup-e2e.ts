// Real main-process setup service + synthetic gateway and system-browser driver. No live app.
// node --import tsx scripts/hermes-gateway-setup-e2e.ts
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactText } from "@openbot/logging";
import { Effect, Result } from "effect";
import { WebSocketServer } from "ws";
import type { HermesGatewayFailure } from "../src/main/hermes-gateway-protocol";
import { HermesGatewaySetupService } from "../src/main/hermes-gateway-setup-service";

const OUT = resolve(import.meta.dirname, "../.openbot-build/hermes-gateway-setup-e2e");
const cases: string[] = [];
interface FakeOptions {
  native?: boolean;
  badPkce?: boolean;
  tokenRedirect?: string;
  pending?: (callback: URL) => Promise<void>;
}
async function fakeGateway(options: FakeOptions = {}) {
  const codes = new Map<string, { challenge: string; user: string }>();
  const brokers = new Map<string, { challenge: string; redirect: string; state: string }>();
  const sessions = new Map<string, string>();
  const tickets = new Set<string>();
  const secrets = new Set<string>();
  const seen: string[] = [];
  const hiddenProfiles = new Set<string>();
  let browserOpens = 0;
  let tokenPosts = 0;
  let rejectedCallbacks = 0;
  let base = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const route = url.pathname.replace(/^\/hermes/u, "");
    seen.push(route);
    response.setHeader("content-type", "application/json");
    if (route === "/api/status")
      return response.end(
        JSON.stringify({
          auth_required: true,
          auth_flows: options.native === false ? ["cookie"] : ["cookie", "native_pkce"],
        }),
      );
    if (route === "/api/auth/providers")
      return response.end(
        JSON.stringify({
          providers: [
            { name: "basic", display_name: "Password", supports_password: true },
            { name: "nous", display_name: "OAuth", supports_password: false },
          ],
        }),
      );
    if (route === "/auth/native/authorize") {
      const broker = randomBytes(32).toString("base64url");
      assert.ok(url.searchParams.get("code_challenge_method") === "S256", "PKCE uses S256.");
      assert.ok(!url.searchParams.has("code_verifier"), "The browser does not receive the verifier.");
      assert.ok(url.searchParams.get("provider") === "basic", "Only the selected password provider starts sign-in.");
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const callback = new URL(redirect);
      assert.ok(
        callback.protocol === "http:" && callback.hostname === "127.0.0.1" && callback.port !== "",
        "The callback binds an explicit loopback IP and ephemeral port.",
      );
      const state = url.searchParams.get("state") ?? "";
      secrets.add(state);
      brokers.set(broker, { challenge: url.searchParams.get("code_challenge") ?? "", redirect, state });
      response.writeHead(302, {
        location: "/hermes/login",
        "set-cookie": `hermes_session_pkce=${broker}; HttpOnly; Path=/hermes`,
      });
      return response.end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    if (route === "/auth/password-login") {
      const broker = request.headers.cookie?.split("=")[1] ?? "";
      const pending = brokers.get(broker);
      assert.ok(pending, "The gateway owns the password-form broker cookie.");
      const input = JSON.parse(text);
      assert.ok(
        input.password === "synthetic-browser-password" && input.provider === "basic",
        "Credential entry happens on the gateway page.",
      );
      const code = randomBytes(32).toString("base64url");
      codes.set(code, {
        challenge: options.badPkce ? "mismatched-challenge" : pending.challenge,
        user: input.username,
      });
      brokers.delete(broker);
      const next = new URL(pending.redirect);
      next.searchParams.set("code", code);
      next.searchParams.set("state", pending.state);
      secrets.add(code);
      return response.end(JSON.stringify({ ok: true, next: next.href }));
    }
    if (route === "/auth/native/token") {
      tokenPosts += 1;
      assert.ok(
        !request.headers.cookie && !request.headers.authorization,
        "Code exchange has no cookie or existing bearer.",
      );
      if (options.tokenRedirect) {
        response.writeHead(307, { location: options.tokenRedirect });
        return response.end();
      }
      const input = JSON.parse(text);
      const pending = codes.get(input.code);
      codes.delete(input.code);
      secrets.add(input.code_verifier);
      if (
        !pending ||
        createHash("sha256").update(input.code_verifier, "ascii").digest("base64url") !== pending.challenge
      ) {
        response.statusCode = 400;
        return response.end('{"detail":"Invalid or expired authorization code"}');
      }
      const accessToken = randomBytes(32).toString("base64url");
      const refreshToken = randomBytes(32).toString("base64url");
      sessions.set(accessToken, pending.user);
      secrets.add(accessToken);
      secrets.add(refreshToken);
      return response.end(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          user_id: pending.user,
          provider: "basic",
          expires_at: Math.floor(Date.now() / 1_000) + 900,
        }),
      );
    }
    const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
    const user = sessions.get(token);
    assert.ok(!request.headers.cookie, "Native REST authentication does not use browser cookies.");
    if (!user) {
      response.statusCode = 401;
      return response.end('{"error":"unauthenticated"}');
    }
    if (route === "/api/auth/me")
      return response.end(JSON.stringify({ user_id: user, provider: "basic", expires_at: Date.now() / 1_000 + 900 }));
    if (route === "/api/profiles")
      return response.end(
        JSON.stringify({
          profiles: [
            {
              name: `${user}-work`,
              display_name: `${user} Work`,
              is_default: false,
              path: "/private/not-returned",
              private_token: token,
            },
            { name: "default", is_default: true },
          ].filter((profile) => !hiddenProfiles.has(profile.name)),
        }),
      );
    if (route === "/api/auth/ws-ticket") {
      const ticket = randomBytes(32).toString("base64url");
      tickets.add(ticket);
      secrets.add(ticket);
      return response.end(JSON.stringify({ ticket, ttl_seconds: 30 }));
    }
    response.statusCode = 404;
    response.end("{}");
  });
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => "hermes-gateway-v1" });
  server.on("upgrade", (request, socket, head) => {
    assert.ok(
      request.url === "/hermes/api/ws" && !request.headers.cookie && !request.headers.authorization,
      "Socket URLs carry no credentials.",
    );
    const ticket = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim())
      .find((value) => value.startsWith("hermes-gateway-ticket."))
      ?.slice(22);
    assert.ok(ticket && tickets.delete(ticket), "Each native sign-in uses a fresh single-use socket ticket.");
    sockets.handleUpgrade(request, socket, head, (connection) =>
      connection.on("message", () => assert.fail("No chat RPC is permitted.")),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: `${base}/hermes`,
    hideProfile: (id: string) => hiddenProfiles.add(id),
    seen,
    secrets,
    get tokenPosts() {
      return tokenPosts;
    },
    get browserOpens() {
      return browserOpens;
    },
    get rejectedCallbacks() {
      return rejectedCallbacks;
    },
    openBrowser: async (authorization: string) => {
      const user = ++browserOpens === 1 ? "alice" : "bob";
      assert.ok(new URL(authorization).origin === base, "Main opens only the selected gateway origin.");
      const start = await fetch(authorization, { redirect: "manual" });
      assert.ok(
        start.status === 302 && start.headers.get("location") === "/hermes/login",
        "The password provider opens the gateway form.",
      );
      const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
      const password = await fetch(`${base}/hermes/auth/password-login`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ provider: "basic", username: user, password: "synthetic-browser-password" }),
      });
      const body = await password.json();
      const callback = new URL(body.next);
      if (options.pending) return options.pending(callback);
      // Wrong state, non-ASCII state, duplicate code, wrong path, origin and method are ignored.
      for (const variant of ["state", "unicode", "duplicate", "duplicate-state", "path", "origin", "method", "host"]) {
        const invalid = new URL(callback);
        if (variant === "state") invalid.searchParams.set("state", "wrong");
        if (variant === "unicode") invalid.searchParams.set("state", "é".repeat(43));
        if (variant === "duplicate") invalid.searchParams.append("code", "duplicate-code-fixture");
        if (variant === "duplicate-state") invalid.searchParams.append("state", "duplicate-state-fixture");
        if (variant === "host") {
          const status = await new Promise<number>((resolve, reject) => {
            const request = httpRequest(invalid, { headers: { host: "untrusted.example" } }, (reply) => {
              reply.resume();
              reply.on("end", () => resolve(reply.statusCode ?? 0));
            });
            request.on("error", () => reject(new Error("Synthetic callback transport failed")));
            request.end();
          });
          assert.ok(status === 400, "A wrong Host header cannot complete sign-in.");
          rejectedCallbacks += 1;
          continue;
        }
        if (variant === "path") invalid.pathname = "/wrong-path";
        const refusal = await fetch(invalid, {
          headers: variant === "origin" ? { origin: "https://untrusted.example" } : {},
          method: variant === "method" ? "POST" : "GET",
        });
        assert.ok(refusal.status === 400, "Invalid callbacks receive a fixed refusal and do not redeem a code.");
        rejectedCallbacks += 1;
      }
      const accepted = await fetch(callback);
      assert.ok(
        accepted.status === 200 && accepted.headers.get("cache-control") === "no-store",
        "One valid callback completes without caching.",
      );
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

async function expectedFailure<A>(
  operation: Effect.Effect<A, HermesGatewayFailure>,
  code: HermesGatewayFailure["code"],
) {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result) && result.failure.code === code, "The operation returns its fixed failure code.");
}
async function absent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

const folder = await mkdtemp(join(tmpdir(), "openbot-hermes-setup-"));
const gateway = await fakeGateway();
let consent = false;
let prompts = 0;
const promptCount = () => prompts;
let clock = Date.now();
const path = join(folder, "connections.json");
const service = new HermesGatewaySetupService({
  path,
  openBrowser: gateway.openBrowser,
  confirmRemember: async () => {
    prompts += 1;
    return consent;
  },
  now: () => clock,
});
try {
  await Effect.runPromise(service.load());
  assert.ok(service.list().length === 0 && gateway.seen.length === 0, "Startup reads local metadata without network.");
  let rows = await Effect.runPromise(service.probe(gateway.url));
  const first = rows[0];
  assert.ok(first);
  assert.ok(first.providers[0]?.supported && !first.providers[1]?.supported);
  rows = await Effect.runPromise(service.probe(gateway.url));
  const second = rows[1];
  assert.ok(second);
  const firstSignIn = Effect.runPromise(service.signIn(first.id, "basic"));
  await expectedFailure(service.signIn(second.id, "basic"), "busy");
  await firstSignIn;
  assert.ok(gateway.browserOpens === 1, "Overlapping sign-ins do not open another shared browser broker.");
  await Effect.runPromise(service.signIn(second.id, "basic"));
  rows = service.list();
  const connected = rows[0];
  assert.ok(connected && connected.phase === "connected");
  assert.ok(
    rows[0]?.profiles[0]?.id !== rows[1]?.profiles[0]?.id,
    "Completed connections at the same address keep separate identities.",
  );
  const profile = connected.profiles[0]?.id;
  assert.ok(profile);
  assert.ok(
    gateway.rejectedCallbacks === 16 && gateway.tokenPosts === 2,
    "Invalid callbacks never add code exchanges.",
  );
  const safe = JSON.stringify(rows);
  for (const secret of gateway.secrets)
    assert.ok(
      !safe.includes(secret) && !redactText(secret).includes(secret),
      "Safe snapshots exclude secrets and diagnostics mask them.",
    );
  assert.ok(
    !safe.includes("/private/not-returned") && !safe.includes("synthetic-browser-password"),
    "The renderer receives neither credentials nor remote paths.",
  );
  await expectedFailure(service.selectProfile(first.id, "unlisted-profile", true), "profile");
  assert.ok(promptCount() === 0 && (await absent(path)), "An unlisted profile is refused before consent or storage.");
  await Effect.runPromise(service.selectProfile(first.id, profile, false));
  assert.ok(await absent(path), "Session-only selection writes no connection file.");
  await expectedFailure(service.selectProfile(first.id, profile, true), "consent");
  assert.ok(promptCount() === 1 && (await absent(path)), "A rejected native remember prompt writes nothing.");
  consent = true;
  await Effect.runPromise(service.selectProfile(first.id, profile, true));
  const saved = await readFile(path, "utf8");
  const parsed = JSON.parse(saved);
  assert.ok(
    parsed.version === 1 &&
      parsed.entries.length === 1 &&
      Object.keys(parsed.entries[0]).sort().join(",") === "id,profileId,url",
    "Only consented address/profile metadata is saved.",
  );
  for (const secret of gateway.secrets) assert.ok(!saved.includes(secret), "The file contains no session secret.");
  const restart = new HermesGatewaySetupService({
    path,
    openBrowser: gateway.openBrowser,
    confirmRemember: async () => true,
  });
  const count = gateway.seen.length;
  await Effect.runPromise(restart.load());
  const restored = restart.list()[0];
  assert.ok(
    restored?.phase === "signed-out" &&
      restored.remembered &&
      restored.selectedProfileId === profile &&
      gateway.seen.length === count,
    "Restart restores metadata without authentication or startup network.",
  );
  await Effect.runPromise(restart.probe(gateway.url, first.id));
  await expectedFailure(restart.probe(`${gateway.url}/other`, first.id), "invalid-address");
  gateway.hideProfile(profile);
  await Effect.runPromise(restart.signIn(first.id, "basic"));
  assert.ok(
    restart.list()[0]?.selectedProfileId === null,
    "A missing saved profile is not reused as an active selection.",
  );
  await Effect.runPromise(restart.selectProfile(first.id, "default", false));
  assert.ok(
    JSON.parse(await readFile(path, "utf8")).entries.length === 0,
    "Unchecking Remember removes persisted metadata.",
  );
  await Effect.runPromise(restart.forget(first.id));
  await Effect.runPromise(restart.close());
  clock += 3_600_000;
  assert.ok(
    service.list().every((row) => row.phase === "signed-out"),
    "Expired native sessions are cleared without replay or refresh.",
  );
  cases.push(
    "native password PKCE, callback rejection, no secret IPC/storage/logs, serialized browser auth and isolated sessions",
  );
  cases.push(
    "profile validation, explicit native remember consent, session-only default, restart, unremember and forget",
  );
  cases.push("native token expiry requires explicit sign-in; remembered address cannot be rebound");

  for (const original of [
    '{"version":99,"keep":"future-user-data"}',
    '{"version":1,"entries":[],"extra":"future-user-data"}',
  ]) {
    const damaged = join(folder, "future.json");
    await writeFile(damaged, original);
    const readOnly = new HermesGatewaySetupService({
      path: damaged,
      openBrowser: gateway.openBrowser,
      confirmRemember: async () => true,
    });
    await Effect.runPromise(readOnly.load());
    const draft = (await Effect.runPromise(readOnly.probe(gateway.url)))[0];
    assert.ok(draft);
    await Effect.runPromise(readOnly.signIn(draft.id, "basic"));
    await expectedFailure(readOnly.selectProfile(draft.id, "default", true), "storage");
    assert.ok((await readFile(damaged, "utf8")) === original, "Unknown metadata versions are preserved.");
    await Effect.runPromise(readOnly.close());
  }
  cases.push("unknown saved format is read-only and preserved");

  for (const options of [{ native: false }, { badPkce: true }, { tokenRedirect: "http://127.0.0.1:1/never-forward" }]) {
    const fake = await fakeGateway(options);
    const rejected = new HermesGatewaySetupService({
      path: join(folder, "rejected.json"),
      openBrowser: fake.openBrowser,
      confirmRemember: async () => true,
    });
    try {
      const entry = (await Effect.runPromise(rejected.probe(fake.url)))[0];
      assert.ok(entry);
      await expectedFailure(
        rejected.signIn(entry.id, "basic"),
        options.native === false ? "unsupported-auth" : options.badPkce ? "invalid-response" : "redirect",
      );
      assert.ok(
        rejected.list()[0]?.phase === "signed-out" && fake.tokenPosts <= 1,
        "Failed or uncertain login is never retried.",
      );
      const openedBefore = fake.browserOpens;
      await expectedFailure(rejected.signIn(entry.id, "nous"), "unsupported-auth");
      assert.ok(fake.browserOpens === openedBefore, "Unsupported OAuth providers cannot open a sign-in browser.");
      if (options.native === false)
        assert.ok(fake.browserOpens === 0, "A cookie-only gateway cannot start the native flow.");
    } finally {
      await Effect.runPromise(rejected.close());
      await fake.close();
    }
  }
  cases.push(
    "missing native capability, unsupported OAuth, invalid PKCE and redirecting code exchange fail closed without retry",
  );

  for (const shutdown of [false, true]) {
    let opened: (callback: URL) => void = () => {};
    const pending = new Promise<URL>((resolve) => {
      opened = resolve;
    });
    const held = await fakeGateway({
      pending: async (callback) => {
        opened(callback);
        await new Promise<void>(() => {});
      },
    });
    const cancel = new HermesGatewaySetupService({
      path: join(folder, "cancel.json"),
      openBrowser: held.openBrowser,
      confirmRemember: async () => true,
    });
    try {
      const row = (await Effect.runPromise(cancel.probe(held.url)))[0];
      assert.ok(row);
      const login = expectedFailure(cancel.signIn(row.id, "basic"), "closed");
      const callback = await pending;
      if (shutdown) await Effect.runPromise(cancel.close());
      else await Effect.runPromise(cancel.disconnect(row.id));
      await login;
      const late = await fetch(callback)
        .then((response) => response.status)
        .catch(() => 0);
      assert.ok(
        late !== 200 && held.tokenPosts === 0 && cancel.list()[0]?.phase === "signed-out",
        "Cancellation closes the callback listener and cannot revive a session.",
      );
    } finally {
      await Effect.runPromise(cancel.close());
      await held.close();
    }
  }
  cases.push("cancelled sign-in closes the loopback listener and rejects late callbacks");
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed: true, cases }, null, 2)}\n`);
  // Machine-readable: fixed descriptions only, no authorization URLs, callback parameters or tokens.
  process.stdout.write(`${JSON.stringify({ passed: true, cases: cases.length })}\n`);
} finally {
  await Effect.runPromise(service.close());
  await gateway.close();
  await rm(folder, { recursive: true, force: true });
}
