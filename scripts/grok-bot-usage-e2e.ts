// Maps sand usage from the Grok Bot account token. The Cursor CLI file stays unread.
// bun scripts/grok-bot-usage-e2e.ts
// Writes .openbot-build/grok-bot-usage-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GrokBotUsageSummary } from "@openbot/contracts/ipc";
import { createFormat } from "@openbot/i18n";
import { Effect } from "effect";
import { grokBotUsageRow } from "../packages/ui/src/features/account/grok-bot-usage-row";
import { GrokBotAccountStore } from "../src/backend/grok-bot/grok-bot-account";
import { readGrokBotUsageSummary } from "../src/backend/grok-bot/grok-bot-usage";

const OUT = resolve(import.meta.dirname, "../.openbot-build/grok-bot-usage-e2e");
const CLI_JSON = `${JSON.stringify({ accessToken: "cli-access", refreshToken: "cli-refresh" }, null, 2)}\n`;
const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8"),
};
const format = createFormat("en");
function labels(summary: GrokBotUsageSummary) {
  const demand = summary.onDemand;
  return {
    name: "Grok Bot",
    included: "Included",
    onDemand: demand
      ? `On demand · ${format.currencyUsd(demand.usedUsd)} of ${format.currencyUsd(demand.limitUsd)}`
      : "",
    formatReset: (date: Date) =>
      format.date(date, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
}

const report = {
  passed: false,
  weekly: false,
  ignoresPlanUsage: false,
  alias: false,
  noGrant: false,
  enterprise: false,
  pooled: false,
  trial: false,
  noCap: false,
  refreshed: false,
  cliUntouched: false,
  usedGrokToken: false,
  usedCliToken: true,
};

const bearers: string[] = [];
let refreshCalls = 0;
let statusCalls = 0;

const weekly = {
  sandUsagePercent: 40,
  nextResetTimestampUtc: "2026-11-06T18:00:00.000Z",
  hasAvailableUsage: true,
  upgradeRecommendation: "raise",
  sandTrialExpiresAt: "2020-01-01T00:00:00.000Z",
};
const period = {
  planUsage: { autoPercentUsed: 99, apiPercentUsed: 88 },
  billingCycleEnd: "1760000000000",
  spendLimitUsage: { individualUsed: 300, individualLimit: 5000 },
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<void> {
  return new Promise((ready) => {
    request.on("data", () => undefined);
    request.on("end", () => ready());
  });
}

const root = await mkdtemp(join(tmpdir(), "openbot-grok-bot-usage-"));
const cliFile = join(root, "cli-auth.json");
writeFileSync(cliFile, CLI_JSON);

const server = createServer((request, response) => {
  const bearer = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
  if (request.url !== "/oauth/token") bearers.push(bearer);
  void readBody(request).then(() => {
    if (request.url === "/oauth/token") {
      refreshCalls += 1;
      json(response, 200, { access_token: "grok-access-e2e-2", refresh_token: "grok-refresh-e2e" });
      return;
    }
    if (request.url?.endsWith("GetSandUsageStatus")) {
      statusCalls += 1;
      if (mode === "refresh" && statusCalls === 1) {
        response.writeHead(401).end();
        return;
      }
      if (mode === "refresh" && statusCalls > 2) {
        response.writeHead(401).end();
        return;
      }
      json(
        response,
        200,
        mode === "alias"
          ? { usagePercent: 15 }
          : mode === "empty"
            ? {}
            : mode === "pooled"
              ? { ...weekly, usesPooledEnterpriseAllowance: true }
              : mode === "trial"
                ? { ...weekly, sandTrialExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }
                : weekly,
      );
      return;
    }
    if (request.url?.endsWith("GetCurrentPeriodUsage")) {
      json(
        response,
        200,
        mode === "nocap"
          ? { spendLimitUsage: { individualUsed: 10, individualLimit: 0 } }
          : mode === "empty"
            ? {}
            : period,
      );
      return;
    }
    if (request.url?.endsWith("GetTeams")) {
      json(response, 200, mode === "enterprise" ? { teams: [{ id: "t1" }] } : { teams: [] });
      return;
    }
    if (request.url?.endsWith("GetSandTrialClaimStatus")) {
      json(response, 200, mode === "trial" ? { claimable: true } : {});
      return;
    }
    response.writeHead(404).end();
  });
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert.ok(address !== null && typeof address === "object");
const apiBaseUrl = `http://127.0.0.1:${address.port}`;
let mode = "weekly";

async function readCase(name: string) {
  const authFile = join(root, `${name}.json`);
  const store = new GrokBotAccountStore(authFile, cipher);
  await Effect.runPromise(
    store.save({ accessToken: "grok-access-e2e", refreshToken: "grok-refresh-e2e", gateway: null }),
  );
  return Effect.runPromise(readGrokBotUsageSummary(store, { apiBaseUrl }));
}

try {
  mode = "weekly";
  const weeklySummary = await readCase("weekly");
  const reset = Date.parse("2026-11-06T18:00:00.000Z") / 1000;
  report.weekly =
    weeklySummary?.includedUsedPercent === 40 &&
    weeklySummary.includedResetsAt === reset &&
    weeklySummary.onDemand?.usedUsd === 3 &&
    weeklySummary.onDemand.limitUsd === 50 &&
    weeklySummary.onDemand.usedPercent === 6 &&
    weeklySummary.changeLimit === true &&
    !JSON.stringify(weeklySummary).includes("raise") &&
    weeklySummary.trialActive === false &&
    weeklySummary.enterprise === false;
  report.ignoresPlanUsage = weeklySummary?.includedUsedPercent !== 99;
  assert.equal(report.weekly, true);
  const row = weeklySummary ? grokBotUsageRow(weeklySummary, labels(weeklySummary)) : null;
  assert.equal(row?.name, "Grok Bot");
  assert.equal(row?.provider, "grok");
  assert.equal(row?.accountId, "grok-bot");
  assert.equal(row?.sharedQuotaWith, null);
  assert.equal(row?.reportsUsage, true);
  assert.equal(row?.windows[0]?.label, "Included");
  assert.equal(row?.windows[0]?.remainingPercent, 60);
  assert.equal(row?.windows[0]?.resetsAt, reset);
  assert.equal(row?.windows[1]?.label, `On demand · ${format.currencyUsd(3)} of ${format.currencyUsd(50)}`);
  assert.equal(row?.windows[1]?.remainingPercent, 94);

  mode = "alias";
  const alias = await readCase("alias");
  report.alias = alias?.includedUsedPercent === 15;
  assert.equal(report.alias, true);

  mode = "empty";
  const empty = await readCase("empty");
  report.noGrant =
    empty !== null && empty.includedUsedPercent === null && grokBotUsageRow(empty, labels(empty)) === null;
  assert.equal(report.noGrant, true);

  mode = "enterprise";
  const enterprise = await readCase("enterprise");
  const enterpriseRow = enterprise ? grokBotUsageRow(enterprise, labels(enterprise)) : null;
  report.enterprise =
    enterprise?.enterprise === true &&
    enterpriseRow?.windows.every((window) => window.label !== "Included") === true &&
    enterpriseRow.windows.length === 1;
  assert.equal(report.enterprise, true);

  mode = "pooled";
  const pooled = await readCase("pooled");
  const pooledRow = pooled ? grokBotUsageRow(pooled, labels(pooled)) : null;
  report.pooled =
    pooled?.enterprise === true && pooledRow?.windows.every((window) => window.label !== "Included") === true;
  assert.equal(report.pooled, true);

  mode = "trial";
  const trial = await readCase("trial");
  report.trial = trial?.trialClaim === true && trial.trialActive === true;
  assert.equal(report.trial, true);

  mode = "nocap";
  const noCap = await readCase("nocap");
  report.noCap = noCap?.onDemand === null;
  assert.equal(report.noCap, true);

  mode = "refresh";
  statusCalls = 0;
  refreshCalls = 0;
  const refreshed = await readCase("refresh");
  report.refreshed = refreshed?.includedUsedPercent === 40 && refreshCalls === 1;
  assert.equal(report.refreshed, true);

  report.cliUntouched = readFileSync(cliFile, "utf8") === CLI_JSON;
  report.usedCliToken = bearers.includes("cli-access");
  report.usedGrokToken = bearers.length > 0 && bearers.every((token) => token.startsWith("grok-access-e2e"));
  assert.equal(report.cliUntouched, true);
  assert.equal(report.usedCliToken, false);
  assert.equal(report.usedGrokToken, true);
  report.passed = true;
} finally {
  await new Promise<void>((ready, reject) => server.close((error) => (error ? reject(error) : ready())));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exit(1);
