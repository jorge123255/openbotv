import { describe, expect, it } from "vitest";
import {
  parseProbeHermesGateway,
  parseSelectHermesGatewayProfile,
  parseSignInHermesGateway,
} from "../main/ipc/hermes-gateway-inputs";
import { decodeHermesGatewaySetups } from "./hermes-gateway-decoding";

const entry = {
  id: "12345678-1234-4234-9234-123456789abc",
  url: "https://gateway.example/hermes",
  phase: "connected",
  remembered: false,
  selectedProfileId: null,
  expiresAt: null,
  providers: [{ id: "basic", name: "Password", supported: true, access_token: "synthetic-private-access" }],
  profiles: [{ id: "work", name: "Work", private_path: "/private/home" }],
  access_token: "synthetic-private-access",
  refresh_token: "synthetic-private-refresh",
  authorizationUrl: "never-expose",
};

describe("Hermes setup IPC boundary", () => {
  it("projects only credential-free setup fields into the renderer", () => {
    const decoded = decodeHermesGatewaySetups([entry]);
    const serialized = JSON.stringify(decoded);
    expect(serialized).not.toContain("synthetic-private");
    expect(serialized).not.toContain("/private/home");
    expect(serialized).not.toContain("authorizationUrl");
    expect(decoded[0]?.profiles).toEqual([{ id: "work", name: "Work" }]);
  });
  it("refuses secret-bearing addresses and malformed main replies", () => {
    for (const url of [
      "https://user:pass@gateway.example",
      "https://gateway.example?token=secret",
      "https://gateway.example/#secret",
      "javascript:alert(1)",
    ])
      expect(() => decodeHermesGatewaySetups([{ ...entry, url }])).toThrow();
    expect(() => decodeHermesGatewaySetups([{ ...entry, phase: "unexpected" }])).toThrow();
    expect(() =>
      decodeHermesGatewaySetups([{ ...entry, providers: [{ id: "basic", name: "Password", supported: "yes" }] }]),
    ).toThrow();
    expect(() => decodeHermesGatewaySetups(Array.from({ length: 9 }, () => entry))).toThrow();
  });
  it("does not accept credential fields or implicit persistence through setup inputs", () => {
    expect(() => parseProbeHermesGateway({ url: "https://gateway.example", password: "synthetic" })).toThrow();
    expect(() => parseSignInHermesGateway({ id: entry.id, providerId: "basic", access_token: "synthetic" })).toThrow();
    expect(() => parseSelectHermesGatewayProfile({ id: entry.id, profileId: "work" })).toThrow();
    expect(() => parseSelectHermesGatewayProfile({ id: entry.id, profileId: "work", remember: "yes" })).toThrow();
    expect(parseSelectHermesGatewayProfile({ id: entry.id, profileId: "work", remember: false }).remember).toBe(false);
  });
});
