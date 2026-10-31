import {
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationPreparationPlan,
  type MigrationPreparationState,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerSettingsStory, serverSettingsArgs } from "./server-settings-story";

const meta = {
  title: "Settings/Migration preparation",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const savedPlan = (): MigrationPreparationPlan => ({
  id: "7ea568b0-8f81-4e79-91c6-8a20429b5a91",
  createdAt: "2026-10-31T10:00:00.000Z",
  updatedAt: "2026-10-31T10:00:00.000Z",
  status: "prepared",
  destinationKind: "docker-host",
  inventory: { agents: 3, conversations: 8, messages: 45, attachments: 4, routines: 2 },
  observation: "metadata-only",
  blockers: [...MIGRATION_PREPARATION_BLOCKERS],
  operations: { export: false, restore: false, activate: false },
});

/** Story-only records. Main owns the durable journal in the application. */
function fixtureCalls(plan: MigrationPreparationPlan | null = null): OpenBotDesktopApi["migrationPreparation"] {
  let state: MigrationPreparationState = { revision: plan?.status === "cancelled" ? 2 : plan ? 1 : 0, plan };
  return {
    getState: async () => structuredClone(state),
    prepare: async (input) => {
      if (input.expectedRevision !== state.revision || state.plan?.status === "prepared")
        throw new Error("Synthetic preparation revision conflict.");
      state = {
        revision: state.revision + 1,
        plan: { ...savedPlan(), id: crypto.randomUUID(), destinationKind: input.destinationKind },
      };
      return structuredClone(state);
    },
    cancel: async (input) => {
      if (
        input.expectedRevision !== state.revision ||
        state.plan?.id !== input.planId ||
        state.plan.status !== "prepared"
      )
        throw new Error("Synthetic preparation revision conflict.");
      state = { revision: state.revision + 1, plan: { ...state.plan, status: "cancelled" } };
      return structuredClone(state);
    },
  };
}

/** Uses the real Server settings container and renderer bridge adapter. */
export const InServerSettings: Story = {
  name: "Server settings",
  render: () => (
    <ServerSettingsStory
      settings={{
        ...serverSettingsArgs(),
        migrationPreparation: { calls: fixtureCalls() },
        initialSection: "migration",
      }}
    />
  ),
};

export const SavedPlan: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{
        ...serverSettingsArgs(),
        migrationPreparation: { calls: fixtureCalls(savedPlan()) },
        initialSection: "migration",
      }}
    />
  ),
};

export const CancelledPlan: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{
        ...serverSettingsArgs(),
        migrationPreparation: { calls: fixtureCalls({ ...savedPlan(), status: "cancelled" }) },
        initialSection: "migration",
      }}
    />
  ),
};
