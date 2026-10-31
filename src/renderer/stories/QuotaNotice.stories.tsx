import type { OllamaQuotaSnapshot } from "@openbot/contracts/ipc";
import { QuotaNotice } from "@openbot/ui/features/conversation/QuotaNotice";
import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const now = Date.UTC(2026, 9, 31, 12);
const reading: OllamaQuotaSnapshot = {
  connectionId: "mock-cloud",
  connectionName: "Personal cloud",
  poolId: "mock-pool",
  state: "fresh",
  checkedAt: now,
  retryAt: now + 60_000,
  purchasedBalanceUsd: 25,
  windows: [
    {
      id: "included",
      usedPercent: 95,
      startsAt: now - 86_400_000,
      resetsAt: now + 86_400_000,
      balanceUsd: 5,
      allowanceUsd: 100,
      warningId: "mock-warning",
    },
  ],
};
const meta = {
  title: "Conversation/Account quota",
  component: QuotaNotice,
  args: { reading, connectionName: reading.connectionName, now, onDismiss: () => undefined },
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof QuotaNotice>;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture(props: Parameters<typeof QuotaNotice>[0]) {
  const [dismissed, setDismissed] = createSignal(false);
  const [switched, setSwitched] = createSignal(false);
  return (
    <div class="composer-wrap" style={{ width: "min(640px, 100%)", padding: "16px" }}>
      <QuotaNotice
        {...props}
        reading={
          props.reading
            ? {
                ...props.reading,
                windows: props.reading.windows.map((window) => ({
                  ...window,
                  warningId: dismissed() ? null : window.warningId,
                })),
              }
            : null
        }
        onDismiss={() => setDismissed(true)}
        recommendation={{
          key: "claude/mock",
          model: "Mock Claude",
          provider: "Claude",
          account: "Personal account",
          onConfirm: async () => {
            setSwitched(true);
            return true;
          },
        }}
      />
      <output aria-label="Next turn model">{switched() ? "Mock Claude" : "Ollama Cloud"}</output>
    </div>
  );
}
export const Warning: Story = { render: (args) => <Fixture {...args} /> };
export const BelowThreshold: Story = {
  args: {
    reading: {
      ...reading,
      windows: reading.windows.map((window) => ({ ...window, usedPercent: 89.999, warningId: null })),
    },
  },
  render: (args) => <Fixture {...args} />,
};
export const Stale: Story = {
  args: { reading: { ...reading, state: "stale" } },
  render: (args) => <Fixture {...args} />,
};
export const Unknown: Story = {
  args: {
    reading: {
      ...reading,
      windows: reading.windows.map((window) => ({ ...window, usedPercent: null, warningId: null })),
      purchasedBalanceUsd: null,
    },
  },
  render: (args) => <Fixture {...args} />,
};
export const Unavailable: Story = { args: { reading: null }, render: (args) => <Fixture {...args} /> };
export const Expired: Story = { args: { now: now + 180_000 }, render: (args) => <Fixture {...args} /> };
export const LegacyWindows: Story = {
  args: {
    reading: {
      ...reading,
      windows: [
        {
          ...reading.windows[0],
          id: "session",
          usedPercent: 92,
          startsAt: null,
          resetsAt: now + 3_600_000,
          balanceUsd: null,
          allowanceUsd: null,
          warningId: "mock-session",
        },
        {
          ...reading.windows[0],
          id: "weekly",
          usedPercent: 40,
          startsAt: null,
          resetsAt: now + 7 * 86_400_000,
          balanceUsd: null,
          allowanceUsd: null,
          warningId: null,
        },
      ],
    },
  },
  render: (args) => <Fixture {...args} />,
};
