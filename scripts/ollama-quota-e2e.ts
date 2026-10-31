// Runs the real local quota service with injected HTTP, clock and saved connections only.
// No account, CLI, credential file, app process or network is used.
// Run: bun scripts/ollama-quota-e2e.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentModelOption, AgentSummary, OllamaQuotaSnapshot } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { CustomProviderConfig } from "../src/backend/opencode-config";
import { OllamaQuotaService } from "../src/main/ollama-quota-service";
import { decodeOllamaQuota } from "../src/preload/ollama-quota-decoding";

const output = resolve(import.meta.dirname, "../.openbot-build/ollama-quota-e2e");
mkdirSync(output, { recursive: true });
const report: { passed: boolean; cases: string[]; failure?: string } = { passed: false, cases: [] };
const initial = Date.UTC(2026, 9, 31, 12);
const iso = (time: number) => new Date(time).toISOString();
const connection: CustomProviderConfig = {
  id: "cloud",
  name: "Mock cloud",
  baseUrl: "https://ollama.com/v1",
  apiKey: "mock-key-never-valid",
  headers: [],
  harness: "opencode",
  models: [{ id: "mock-model", name: "Mock model" }],
};
type Agent = Pick<AgentSummary, "id" | "provider" | "model">;
type Model = Pick<AgentModelOption, "id" | "provider">;
function fixture() {
  let now = initial;
  let configs = [connection];
  let agents: Agent[] = [{ id: "one", provider: "opencode", model: "cloud/mock-model" }];
  let models: Model[] = [{ provider: "opencode", id: "cloud/mock-model" }];
  let reply: () => Promise<Response> = async () => Response.json(monthly(50));
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const service = new OllamaQuotaService({
    configs: () => configs,
    agents: () => agents,
    models: () => models,
    now: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return reply();
    },
  });
  return {
    service,
    calls,
    read: (id = "one") => Effect.runPromise(service.read(id)),
    advance: (ms = 60_000) => {
      now += ms;
    },
    configs: (value: CustomProviderConfig[]) => {
      configs = value;
    },
    agents: (value: Agent[]) => {
      agents = value;
    },
    models: (value: Model[]) => {
      models = value;
    },
    reply: (value: unknown) => {
      reply = async () => Response.json(value);
    },
    http: (value: () => Promise<Response>) => {
      reply = value;
    },
  };
}
function monthly(used: number, start = initial - 86_400_000, until = initial + 30 * 86_400_000) {
  return {
    included: { balance_usd: 100 - used, allowance_usd: 100, period: { from: iso(start), until: iso(until) } },
    purchased: { balance_usd: 25 },
  };
}
function warning(reading: OllamaQuotaSnapshot | null, index = 0) {
  return reading?.windows[index]?.warningId ?? null;
}
async function check(name: string, run: () => Promise<void>) {
  await run();
  report.cases.push(name);
}

try {
  await check(
    "Binding rejects local/proxy/ambiguous credentials, absent catalog and mismatched harness/model",
    async () => {
      const f = fixture();
      for (const changes of [
        { baseUrl: "http://localhost:11434/v1" },
        { baseUrl: "https://ollama.com.evil.test/v1" },
        { baseUrl: "https://user@ollama.com/v1" },
        { baseUrl: "https://ollama.com/v1?key=secret" },
        { baseUrl: "https://ollama.com/other" },
        { apiKey: null },
        { headers: [{ name: "Authorization", value: "mock-override" }] },
        { harness: "pi" as const },
        { models: [{ id: "other", name: "Other" }] },
      ]) {
        f.configs([{ ...connection, ...changes }]);
        assert.equal(await f.read(), null);
      }
      f.configs([connection]);
      f.models([]);
      assert.equal(await f.read(), null);
      f.models([{ provider: "opencode", id: "cloud/mock-model" }]);
      assert.equal(await f.read("missing"), null);
      assert.equal(f.calls.length, 0);
      f.service.dispose();
    },
  );
  await check(
    "Fixed endpoint confines key, strips provider fields, caches and coalesces concurrent reads",
    async () => {
      const f = fixture();
      f.reply({ ...monthly(89.999), apiKey: "do-not-return", account: "private" });
      const [first, second] = await Promise.all([f.read(), f.read()]);
      assert.equal(first?.state, "fresh");
      assert.deepEqual(second, first);
      assert.equal(warning(first), null, "A rounded 90 is not an alert.");
      assert.equal(first?.purchasedBalanceUsd, 25);
      assert.equal(f.calls.length, 1);
      const call = f.calls[0];
      assert.ok(call);
      assert.equal(call.url, "https://ollama.com/api/balance");
      assert.equal(call.init?.redirect, "error");
      assert.equal(call.init?.credentials, "omit");
      assert.deepEqual(call.init?.headers, {
        Accept: "application/json",
        Authorization: "Bearer mock-key-never-valid",
      });
      assert.ok(!JSON.stringify(first).includes("mock-key"));
      assert.ok(!JSON.stringify(first).includes("private"));
      assert.deepEqual(decodeOllamaQuota(first), first);
      f.service.dispose();
    },
  );
  await check("90% threshold, shared-pool dismissal, recovery hysteresis and period reset", async () => {
    const f = fixture();
    f.reply(monthly(90));
    const first = await f.read();
    const id = warning(first);
    assert.ok(id);
    f.agents([
      { id: "one", provider: "opencode", model: "cloud/mock-model" },
      { id: "two", provider: "opencode", model: "cloud/mock-model" },
    ]);
    assert.equal(warning(await f.read("two")), id);
    assert.equal(f.calls.length, 1);
    f.service.dismiss(id);
    assert.equal(warning(await f.read("two")), null);
    f.advance();
    f.reply(monthly(86));
    await f.read();
    f.advance();
    f.reply(monthly(95));
    assert.equal(warning(await f.read()), null);
    f.advance();
    f.reply(monthly(84));
    await f.read();
    f.advance();
    f.reply(monthly(90));
    const recovered = warning(await f.read());
    assert.ok(recovered);
    assert.notEqual(recovered, id);
    f.service.dismiss(recovered);
    f.advance();
    f.reply(monthly(91, initial + 60_000, initial + 31 * 86_400_000));
    assert.ok(warning(await f.read()), "A new period rearms the warning.");
    f.service.dispose();
  });
  await check(
    "Legacy windows remain separate; invalid/missing denominators and expired windows stay unknown",
    async () => {
      const f = fixture();
      f.reply({
        included: {
          session: { remaining_percent: 9, resets_at: iso(initial + 3_600_000) },
          weekly: { remaining_percent: 75, resets_at: iso(initial + 86_400_000) },
        },
        purchased: { balance_usd: 0 },
      });
      const legacy = await f.read();
      assert.equal(legacy?.windows[0]?.usedPercent, 91);
      assert.equal(legacy?.windows[1]?.usedPercent, 25);
      assert.ok(warning(legacy));
      assert.equal(warning(legacy, 1), null);
      for (const included of [
        { balance_usd: 0, allowance_usd: 0, period: { from: iso(initial - 1), until: iso(initial + 86_400_000) } },
        { balance_usd: 101, allowance_usd: 100, period: { from: iso(initial - 1), until: iso(initial + 86_400_000) } },
        { balance_usd: -1, allowance_usd: 100 },
        { balance_usd: 1, allowance_usd: 100, period: { from: iso(initial - 86_400_000), until: iso(initial) } },
        {
          balance_usd: 1,
          allowance_usd: 100,
          period: { from: "2026-02-31T00:00:00Z", until: iso(initial + 86_400_000) },
        },
        { weekly: { remaining_percent: 0 } },
      ]) {
        f.advance();
        f.reply({ included });
        const value = await f.read();
        assert.equal(value?.windows[0]?.usedPercent, null);
        assert.equal(warning(value), null);
      }
      f.service.dispose();
    },
  );
  await check("Errors and Retry-After keep last success stale, suppress warnings and limit all keys", async () => {
    const f = fixture();
    f.reply(monthly(95));
    const first = await f.read();
    assert.ok(warning(first));
    f.advance();
    f.http(async () => new Response("secret-error-do-not-return", { status: 429, headers: { "retry-after": "180" } }));
    const stale = await f.read();
    assert.equal(stale?.state, "stale");
    assert.equal(stale?.checkedAt, first?.checkedAt);
    assert.equal(warning(stale), null);
    assert.ok(!JSON.stringify(stale).includes("secret-error"));
    f.configs([connection, { ...connection, id: "other", apiKey: "mock-other-key" }]);
    f.agents([
      { id: "one", provider: "opencode", model: "cloud/mock-model" },
      { id: "two", provider: "opencode", model: "other/mock-model" },
    ]);
    f.models([
      { provider: "opencode", id: "cloud/mock-model" },
      { provider: "opencode", id: "other/mock-model" },
    ]);
    f.advance();
    assert.equal((await f.read("two"))?.state, "unavailable");
    assert.equal(f.calls.length, 2);
    f.advance(120_000);
    f.reply(monthly(96));
    assert.equal((await f.read("two"))?.state, "fresh");
    f.advance();
    assert.equal(warning(await f.read()), warning(first), "An error does not rearm an existing episode.");
    f.service.dispose();
  });
  await check("Visible pools take turns under stable polling order; closed views expire", async () => {
    const f = fixture();
    f.configs([connection, { ...connection, id: "other", apiKey: "mock-other-key" }]);
    f.agents([
      { id: "one", provider: "opencode", model: "cloud/mock-model" },
      { id: "two", provider: "opencode", model: "other/mock-model" },
    ]);
    f.models([
      { provider: "opencode", id: "cloud/mock-model" },
      { provider: "opencode", id: "other/mock-model" },
    ]);
    await f.read();
    await f.read("two");
    for (let poll = 0; poll < 4; poll++) {
      f.advance(15_000);
      await f.read();
      await f.read("two");
    }
    assert.equal(f.calls.length, 2);
    assert.equal(new Headers(f.calls[1]?.init?.headers).get("Authorization"), "Bearer mock-other-key");
    for (let poll = 0; poll < 4; poll++) {
      f.advance(15_000);
      await f.read();
      await f.read("two");
    }
    assert.equal(f.calls.length, 3);
    assert.equal(new Headers(f.calls[2]?.init?.headers).get("Authorization"), "Bearer mock-key-never-valid");
    f.advance();
    await f.read();
    assert.equal(f.calls.length, 4);
    f.service.dispose();
  });
  await check("Retry-After dates and huge numeric headers retain a finite global deadline", async () => {
    const f = fixture();
    f.http(
      async () =>
        new Response("", { status: 429, headers: { "retry-after": new Date(initial + 300_000).toUTCString() } }),
    );
    const first = await f.read();
    assert.equal(first?.retryAt, initial + 300_000);
    f.advance();
    await f.read();
    assert.equal(f.calls.length, 1);
    f.advance(240_000);
    f.reply(monthly(50));
    assert.equal((await f.read())?.state, "fresh");
    f.advance();
    f.http(async () => new Response("", { status: 429, headers: { "retry-after": "1".padEnd(309, "0") } }));
    const bounded = await f.read();
    assert.ok(Number.isFinite(bounded?.retryAt));
    assert.equal(bounded?.retryAt, Number.MAX_SAFE_INTEGER);
    f.service.dispose();
  });
  await check(
    "Redirect, oversized/malformed response and transport errors fail closed without secret text",
    async () => {
      for (const response of [
        () => Promise.resolve(new Response("", { status: 302, headers: { location: "https://evil.test" } })),
        () => Promise.resolve(new Response("{}", { headers: { "content-length": "40000" } })),
        () => Promise.resolve(new Response("not JSON")),
        () => Promise.resolve(new Response(" ".repeat(40_000))),
        () => Promise.reject(new Error("Bearer mock-key-never-valid")),
      ]) {
        const f = fixture();
        f.http(response);
        const value = await f.read();
        assert.equal(value?.state, "unavailable");
        assert.equal(value?.checkedAt, null);
        assert.equal(warning(value), null);
        assert.ok(!JSON.stringify(value).includes("mock-key"));
        f.service.dispose();
      }
    },
  );
  await check(
    "Connection edits, catalog removal and teardown discard in-flight results and abort owned requests",
    async () => {
      for (const action of ["edit", "catalog", "dispose"]) {
        const f = fixture();
        let release!: (value: Response) => void;
        let started!: () => void;
        const began = new Promise<void>((resolve) => {
          started = resolve;
        });
        f.http(() => {
          started();
          return new Promise((resolve) => {
            release = resolve;
          });
        });
        const result = f.read();
        await began;
        if (action === "edit") {
          f.configs([{ ...connection, apiKey: "mock-rotated-key" }]);
          f.service.invalidate();
        }
        if (action === "catalog") f.models([]);
        if (action === "dispose") f.service.dispose();
        if (action !== "catalog") assert.equal(f.calls[0]?.init?.signal?.aborted, true);
        release(Response.json(monthly(99)));
        assert.equal(await result, null);
        f.service.dispose();
      }
    },
  );
  await check("Preload decoder rejects malformed values and returns only safe documented fields", async () => {
    const f = fixture();
    const reading = await f.read();
    assert.ok(reading);
    assert.deepEqual(decodeOllamaQuota({ ...reading, apiKey: "mock-secret", raw: { secret: "mock" } }), reading);
    for (const invalid of [
      undefined,
      {},
      { ...reading, retryAt: Number.NaN },
      { ...reading, state: "ready" },
      { ...reading, windows: [{ ...reading.windows[0], usedPercent: 101 }] },
    ])
      assert.throws(() => decodeOllamaQuota(invalid));
    f.service.dispose();
  });
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
