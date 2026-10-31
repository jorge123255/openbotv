// Real local quota service and HTTP adapter, injected responses and clock. No listener, CLI or account.
// Run: bun scripts/kimi-cli-usage-e2e.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { KimiCliUsageService } from "../src/main/kimi-cli-usage-service";
import { decodeKimiCliUsage } from "../src/preload/kimi-cli-usage-decoding";

const output = resolve(import.meta.dirname, "../.openbot-build/kimi-cli-usage-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; failure?: string } = { passed: false, cases: [] };
const initial = Date.UTC(2026, 9, 31, 12);
const iso = (time: number) => new Date(time).toISOString();
const envelope = (data: unknown) => Response.json({ code: 0, msg: "", request_id: "mock", data });
const meta = {
  server_version: "2.3.3",
  server_id: "mock-server",
  started_at: iso(initial - 60_000),
  dangerous_bypass_auth: false,
};
const profile = (userId = "mock-user") => ({
  kind: "ok",
  userInfo: { userId, region: "cn", domain: 0, email: "private@example.invalid" },
});
const quota = () => ({
  kind: "ok",
  quota: {
    usages: {
      limit5h: { usedRatio: 0.895, resetAt: iso(initial + 3_600_000) },
      limit7d: { usedRatio: 0.05, resetAt: iso(initial + 86_400_000) },
      monthTotal: { usedRatio: 0.1 },
      monthCode: { usedRatio: 0.03 },
    },
    extraUsage: { balanceCents: 250, totalCents: 500, currency: "USD", monthlyUsedCents: 20 },
  },
});
function fixture() {
  let now = initial;
  let handler: (url: string, init: RequestInit) => Promise<Response> = async (url) =>
    envelope(url.endsWith("/meta") ? meta : url.includes("/userinfo?") ? profile() : quota());
  const calls: { url: string; init: RequestInit }[] = [];
  const service = new KimiCliUsageService({
    now: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  });
  return {
    service,
    calls,
    connect: () =>
      Effect.runPromise(service.connect({ port: 58627, token: "fixture-token-never-real", allowRefresh: true })),
    read: () => Effect.runPromise(service.read()),
    advance: (ms = 60_000) => {
      now += ms;
    },
    http: (value: typeof handler) => {
      handler = value;
    },
  };
}
async function check(name: string, run: () => Promise<void>) {
  await run();
  report.cases.push(name);
}
try {
  await check(
    "No requests before explicit connect; fixed GET routes, omitted cookies, redirects forbidden and data allowlisted",
    async () => {
      const f = fixture();
      f.service.get();
      await f.read();
      assert.equal(f.calls.length, 0);
      const value = decodeKimiCliUsage(await f.connect());
      assert.equal(value.state, "ready");
      assert.equal(value.windows[0]?.usedRatio, 0.895);
      assert.equal(value.extraBalanceCents, 250);
      assert.equal(value.currency, "USD");
      assert.equal(f.calls.length, 5);
      for (const call of f.calls) {
        assert.ok(
          [
            "http://127.0.0.1:58627/api/v1/meta",
            "http://127.0.0.1:58627/api/v1/oauth/userinfo?provider=managed:kimi-code",
            "http://127.0.0.1:58627/api/v1/oauth/usage?provider=managed:kimi-code",
          ].includes(call.url),
        );
        assert.equal(call.init.method, "GET");
        assert.equal(call.init.redirect, "error");
        assert.equal(call.init.credentials, "omit");
        assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer fixture-token-never-real");
      }
      assert.ok(!JSON.stringify(value).includes("mock-user"));
      assert.ok(!JSON.stringify(value).includes("fixture-token"));
      f.service.dispose();
    },
  );
  await check(
    "One-minute explicit-read budget survives reconnect; cached reads and advancing clock never poll",
    async () => {
      const f = fixture();
      await f.connect();
      await f.read();
      await f.connect();
      assert.equal(f.calls.length, 5);
      assert.ok(f.service.get().retryAt > initial);
      f.advance(300_000);
      f.service.get();
      assert.equal(f.calls.length, 5);
      await f.read();
      assert.equal(f.calls.length, 10);
      f.service.dispose();
    },
  );
  await check("Version and authentication-disabled gates stop before account reads", async () => {
    for (const [replacement, reason] of [
      [{ ...meta, server_version: "2.4.0" }, "unsupported"],
      [{ ...meta, dangerous_bypass_auth: true }, "unsafe"],
    ] as const) {
      const f = fixture();
      f.http(async () => envelope(replacement));
      const value = await f.connect();
      assert.equal(value.reason, reason);
      assert.equal(value.connected, false);
      assert.equal(f.calls.length, 1);
      f.service.dispose();
    }
  });
  await check("In-band errors, HTTP errors and redirected responses never produce quota", async () => {
    for (const response of [
      () => Response.json({ code: 9, data: meta }),
      () => new Response("secret", { status: 401 }),
      () => envelope({ kind: "error", message: "secret refresh details" }),
    ]) {
      const f = fixture();
      f.http(async (url) => (url.endsWith("/meta") ? envelope(meta) : response()));
      const value = await f.connect();
      assert.equal(value.state, "unavailable");
      assert.deepEqual(value.windows, []);
      assert.ok(!JSON.stringify(value).includes("secret"));
      f.service.dispose();
    }
    const f = fixture();
    f.http(async () => {
      const response = envelope(meta);
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    assert.equal((await f.connect()).state, "unavailable");
    f.service.dispose();
  });
  await check("Malformed or absent values stay unknown; invalid calendar dates do not become reset times", async () => {
    const f = fixture();
    f.http(async (url) =>
      envelope(
        url.endsWith("/meta")
          ? meta
          : url.includes("/userinfo?")
            ? profile()
            : {
                kind: "ok",
                quota: {
                  usages: {
                    limit5h: { usedRatio: -1, resetAt: "2026-02-31T00:00:00Z" },
                    limit7d: { resetAt: "not-a-date" },
                    monthTotal: { usedRatio: 2 },
                  },
                  extraUsage: { balanceCents: -1, currency: "leak" },
                },
              },
      ),
    );
    const value = await f.connect();
    assert.equal(value.state, "ready");
    assert.deepEqual(
      value.windows.map((item) => [item.usedRatio, item.resetsAt]),
      [
        [null, null],
        [null, null],
        [null, null],
      ],
    );
    assert.equal(value.extraBalanceCents, null);
    assert.equal(value.currency, null);
    f.service.dispose();
  });
  await check("Account switch during a read clears all values and requires reconnect", async () => {
    const f = fixture();
    let profiles = 0;
    f.http(async (url) =>
      envelope(
        url.endsWith("/meta") ? meta : url.includes("/userinfo?") ? profile(++profiles === 1 ? "one" : "two") : quota(),
      ),
    );
    const value = await f.connect();
    assert.equal(value.reason, "accountChanged");
    assert.equal(value.connected, false);
    assert.deepEqual(value.windows, []);
    f.service.dispose();
  });
  await check("Pinned account and server changes clear old readings before quota fetch", async () => {
    for (const change of ["account", "server"]) {
      const f = fixture();
      await f.connect();
      f.advance();
      f.http(async (url) =>
        envelope(
          url.endsWith("/meta")
            ? { ...meta, server_id: change === "server" ? "other" : meta.server_id }
            : profile("other"),
        ),
      );
      const value = await f.read();
      assert.equal(value.reason, change === "server" ? "serverChanged" : "accountChanged");
      assert.deepEqual(value.windows, []);
      assert.equal(value.checkedAt, null);
      f.service.dispose();
    }
  });
  await check("Restart during the read is rejected by the second metadata check", async () => {
    const f = fixture();
    let metas = 0;
    f.http(async (url) =>
      envelope(
        url.endsWith("/meta")
          ? { ...meta, server_id: ++metas === 1 ? "one" : "two" }
          : url.includes("/userinfo?")
            ? profile()
            : quota(),
      ),
    );
    assert.equal((await f.connect()).reason, "serverChanged");
    f.service.dispose();
  });
  await check("Failure after success clears displayed old values; body is bounded", async () => {
    const f = fixture();
    await f.connect();
    f.advance();
    f.http(async () => new Response("x".repeat(65_537)));
    const value = await f.read();
    assert.equal(value.state, "unavailable");
    assert.deepEqual(value.windows, []);
    assert.equal(value.checkedAt, null);
    f.service.dispose();
  });
  await check("Disconnect aborts an in-flight read; its late result cannot restore data or credentials", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    f.http(async (_url, init) => {
      started.resolve();
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted fixture")), { once: true }),
      );
    });
    const pending = f.connect();
    await started.promise;
    assert.equal(f.service.disconnect().state, "disconnected");
    assert.equal((await pending).state, "disconnected");
    f.advance();
    await f.read();
    assert.equal(f.calls.length, 1);
    f.service.dispose();
  });
  await check("A stalled request reaches the adapter deadline and aborts its HTTP signal", async () => {
    const f = fixture();
    let aborted = false;
    f.http(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("timeout fixture"));
            },
            { once: true },
          ),
        ),
    );
    const value = await f.connect();
    assert.equal(value.state, "unavailable");
    assert.equal(aborted, true);
    assert.equal(f.calls.length, 1);
    f.service.dispose();
  });
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : "Unknown fixture failure";
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
