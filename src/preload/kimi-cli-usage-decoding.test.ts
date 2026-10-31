import { describe, expect, it } from "vitest";
import { parseKimiCliUsageConnection, parseKimiCliUsageConsent } from "../main/ipc/kimi-cli-usage-inputs";
import { decodeKimiCliUsage } from "./kimi-cli-usage-decoding";

const empty = {
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
describe("local CLI usage trust boundary", () => {
  it("requires explicit refresh consent and a numeric loopback port", () => {
    for (const allowRefresh of [undefined, false, 1, "true"])
      expect(() => parseKimiCliUsageConsent({ allowRefresh })).toThrow();
    for (const port of [0, -1, 65_536, 1.5, "58627", "https://example.com", Number.NaN])
      expect(() => parseKimiCliUsageConnection({ port, token: "fixture-token", allowRefresh: true })).toThrow();
    expect(
      parseKimiCliUsageConnection({
        port: 58627,
        token: "fixture-token",
        allowRefresh: true,
        host: "https://example.com",
      }),
    ).toEqual({ port: 58627, token: "fixture-token", allowRefresh: true });
  });
  it("rejects missing, oversized and header-injection tokens without echoing them", () => {
    for (const token of ["", " ", "fixture\r\nX: leak", "x".repeat(4097)]) {
      expect(() => parseKimiCliUsageConnection({ port: 58627, token, allowRefresh: true })).toThrow();
    }
  });
  it("drops secrets, account identifiers and arbitrary server fields", () => {
    expect(
      decodeKimiCliUsage({ ...empty, token: "must-not-cross", identity: { userId: "private" }, metadata: "secret" }),
    ).toEqual(empty);
  });
  it("preserves unknown data and refuses invalid percentages and timestamps", () => {
    const base = {
      ...empty,
      connected: true,
      port: 58627,
      state: "ready",
      checkedAt: 10,
      windows: [{ id: "limit5h", usedRatio: null, resetsAt: null }],
    };
    expect(decodeKimiCliUsage(base).windows[0]?.usedRatio).toBeNull();
    for (const usedRatio of [-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5"])
      expect(() => decodeKimiCliUsage({ ...base, windows: [{ id: "limit5h", usedRatio, resetsAt: null }] })).toThrow();
    expect(() => decodeKimiCliUsage({ ...base, checkedAt: -1 })).toThrow();
  });
  it("rejects duplicate windows and stale data hidden in an unavailable response", () => {
    const window = { id: "limit5h", usedRatio: 0, resetsAt: null };
    expect(() => decodeKimiCliUsage({ ...empty, state: "ready", windows: [window, window] })).toThrow();
    expect(() => decodeKimiCliUsage({ ...empty, state: "unavailable", windows: [window] })).toThrow();
  });
});
