import {
  type AppInfo,
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationPreparationPlan,
  type MigrationPreparationState,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { createMemo, onSettled, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { migrationPreparationHostConfirmed } from "../src/features/servers/migration-preparation-platform";
import { ServerSettingsModal } from "../src/features/servers/ServerSettingsModal";
import { PlatformProvider, usePlatform } from "../src/platform";
import { injectedMigrationPreparationCalls } from "./migration-preparation-calls";
import { createMockOpenBot } from "./mock-openbot";
import { ServerSettingsStory, serverSettingsArgs } from "./server-settings-story";
import { SettingsPageStory } from "./settings-page-story";

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

export const WindowsUnavailable: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{
        ...serverSettingsArgs(),
        platform: "win32",
        migrationPreparation: { calls: fixtureCalls() },
        initialSection: "migration",
      }}
    />
  ),
};

export const WindowsCancelledPlan: Story = {
  render: () => (
    <ServerSettingsStory
      settings={{
        ...serverSettingsArgs(),
        platform: "win32",
        migrationPreparation: { calls: fixtureCalls({ ...savedPlan(), status: "cancelled" }) },
        initialSection: "migration",
      }}
    />
  ),
};

/** Exercise the actual provider's host-read and fallback paths without a nested mock. */
function HostMetadataStory(props: { rejected: boolean }) {
  const previous = window.openbot;
  const mock = createMockOpenBot();
  let resolveMetadata: (info: AppInfo) => void = () => undefined;
  const metadata = new Promise<AppInfo>((resolve) => {
    resolveMetadata = resolve;
  });
  const calls = injectedMigrationPreparationCalls() ?? fixtureCalls();
  window.openbot = {
    ...mock.api,
    getAppInfo: async () => {
      if (props.rejected) throw new Error("Synthetic host metadata refusal.");
      return metadata;
    },
  };
  onSettled(() => () => {
    mock.dispose();
    window.openbot = previous;
  });
  return (
    <PlatformProvider>
      <HostMetadataSettings
        calls={calls}
        onResolve={
          props.rejected
            ? undefined
            : () =>
                resolveMetadata({
                  name: "OpenBot",
                  version: "0.0.0-story",
                  platform: "win32",
                  variant: "preview",
                })
        }
      />
    </PlatformProvider>
  );
}

function HostMetadataSettings(props: {
  calls: OpenBotDesktopApi["migrationPreparation"];
  onResolve: (() => void) | undefined;
}) {
  const platform = usePlatform();
  const hostConfirmed = createMemo(() => migrationPreparationHostConfirmed(platform));
  const migrationPreparation = createMemo(() => (hostConfirmed() ? { calls: props.calls } : undefined));
  const reportedPlatform = createMemo(() => platform.appInfo()?.platform ?? "darwin");
  const metadataResult = createMemo(() => {
    const info = platform.appInfo();
    return `${info?.version ?? "pending"} / ${info?.platform ?? "pending"} / ${hostConfirmed() ? "host-confirmed" : "host-unconfirmed"}`;
  });
  return (
    <SettingsPageStory
      title="Server settings"
      controls={
        <>
          <output aria-label="Platform metadata result">{metadataResult()}</output>
          <Show when={props.onResolve}>
            {(resolve) => (
              <Button type="button" onClick={() => resolve()()}>
                Resolve Windows host metadata
              </Button>
            )}
          </Show>
        </>
      }
    >
      {(page) => (
        <ServerSettingsModal
          {...serverSettingsArgs()}
          platform={reportedPlatform()}
          migrationPreparation={migrationPreparation()}
          initialSection="migration"
          page={page()}
        />
      )}
    </SettingsPageStory>
  );
}

export const HostMetadataRejected: Story = {
  render: () => <HostMetadataStory rejected />,
};

export const HostMetadataWindowsConfirmed: Story = {
  render: () => <HostMetadataStory rejected={false} />,
};
