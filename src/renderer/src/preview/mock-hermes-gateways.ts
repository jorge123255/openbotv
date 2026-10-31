import type { HermesGatewaySetup, OpenBotDesktopApi } from "@openbot/contracts/ipc";

/** Synthetic setup only. The preview has no system browser, network, credentials or local files. */
export function createMockHermesGateways(
  initial: readonly HermesGatewaySetup[] = [],
): OpenBotDesktopApi["hermesGateways"] {
  let rows: HermesGatewaySetup[] = structuredClone([...initial]);
  const copy = () => structuredClone(rows);
  return {
    list: async () => copy(),
    probe: async ({ url, id }) => {
      const old = rows.find((row) => row.id === id);
      rows = rows.filter((row) => row.id !== id);
      rows.push({
        id: id ?? crypto.randomUUID(),
        url,
        phase: "discovered",
        remembered: old?.remembered ?? false,
        selectedProfileId: old?.selectedProfileId ?? null,
        expiresAt: null,
        profiles: [],
        providers: [
          { id: "basic", name: "Password", supported: true },
          { id: "nous", name: "Nous OAuth", supported: false },
        ],
      });
      return copy();
    },
    signIn: async ({ id }) => {
      rows = rows.map((row) =>
        row.id === id
          ? {
              ...row,
              phase: "connected",
              expiresAt: Date.now() + 900_000,
              profiles: [
                { id: "default", name: "Default" },
                { id: "work", name: "Work" },
              ],
            }
          : row,
      );
      return copy();
    },
    selectProfile: async ({ id, profileId, remember }) => {
      rows = rows.map((row) => (row.id === id ? { ...row, selectedProfileId: profileId, remembered: remember } : row));
      return copy();
    },
    disconnect: async (id) => {
      rows = rows.map((row) => (row.id === id ? { ...row, phase: "signed-out", profiles: [], expiresAt: null } : row));
      return copy();
    },
    forget: async (id) => {
      rows = rows.filter((row) => row.id !== id);
      return copy();
    },
  };
}
