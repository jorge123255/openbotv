import type { HermesGatewaySetup } from "@openbot/contracts/ipc";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SettingsHermesGatewaysTab } from "../src/features/settings/SettingsHermesGatewaysTab";
import { createMockHermesGateways } from "../src/preview/mock-hermes-gateways";

const meta = { title: "Settings/Hermes Gateways", component: SettingsHermesGatewaysTab } satisfies Meta<
  typeof SettingsHermesGatewaysTab
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Setup: Story = { render: () => <SettingsHermesGatewaysTab api={createMockHermesGateways()} /> };
export const Remembered: Story = {
  render: () => (
    <SettingsHermesGatewaysTab
      api={createMockHermesGateways([
        {
          id: "12345678-1234-4234-9234-123456789abc",
          url: "https://gateway.example/hermes",
          phase: "signed-out",
          remembered: true,
          selectedProfileId: "work",
          expiresAt: null,
          providers: [],
          profiles: [],
        },
      ])}
    />
  ),
};
export const Unsupported: Story = {
  render: () => (
    <SettingsHermesGatewaysTab
      api={createMockHermesGateways([
        {
          id: "12345678-1234-4234-9234-123456789abc",
          url: "https://gateway.example/hermes",
          phase: "discovered",
          remembered: false,
          selectedProfileId: null,
          expiresAt: null,
          providers: [{ id: "nous", name: "Nous OAuth", supported: false }],
          profiles: [],
        },
      ])}
    />
  ),
};

export const Pending: Story = {
  render: () => {
    const api = createMockHermesGateways([
      {
        id: "12345678-1234-4234-9234-123456789abc",
        url: "https://gateway.example/hermes",
        phase: "discovered",
        remembered: false,
        selectedProfileId: null,
        expiresAt: null,
        providers: [{ id: "basic", name: "Password", supported: true }],
        profiles: [],
      },
    ]);
    return <SettingsHermesGatewaysTab api={{ ...api, signIn: () => new Promise<HermesGatewaySetup[]>(() => {}) }} />;
  },
};

export const PendingElsewhere: Story = {
  render: () => (
    <SettingsHermesGatewaysTab
      api={createMockHermesGateways([
        {
          id: "12345678-1234-4234-9234-123456789abc",
          url: "https://gateway.example/hermes",
          phase: "signing-in",
          remembered: false,
          selectedProfileId: null,
          expiresAt: null,
          providers: [{ id: "basic", name: "Password", supported: true }],
          profiles: [],
        },
      ])}
    />
  ),
};
