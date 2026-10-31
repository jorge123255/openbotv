import type { HostReleaseStatus, HostUpdateStatus, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { createMemo, onSettled, snapshot, untrack } from "solid-js";
import { fn } from "storybook/test";
import { ServerSettingsModal, type ServerSettingsModalProps } from "../src/features/servers/ServerSettingsModal";
import { STORY_HOST_STATUS, STORY_INVITES, STORY_PRESENCE, STORY_SERVERS } from "../src/preview/fixtures";
import { injectedMigrationAssessmentCalls } from "./migration-assessment-calls";
import { injectedMigrationDestinationPolicyCalls } from "./migration-destination-policy-calls";
import { injectedMigrationPreparationCalls } from "./migration-preparation-calls";
import { createMockOpenBot } from "./mock-openbot";
import { SettingsPageStory } from "./settings-page-story";

function storyServer(kind: (typeof STORY_SERVERS)[number]["kind"]) {
  const server = STORY_SERVERS.find((item) => item.kind === kind);
  if (!server) throw new Error(`Story server fixtures need a ${kind} server.`);
  return server;
}

export const STORY_LOCAL_SERVER = storyServer("local");
export const STORY_REMOTE_SERVER = storyServer("remote");

/** The props of the real Server settings for this computer, without its optional sections. */
export const serverSettingsArgs = () =>
  ({
    open: true,
    platform: "darwin",
    server: STORY_LOCAL_SERVER,
    hostStatus: STORY_HOST_STATUS,
    members: STORY_PRESENCE.members,
    invites: STORY_INVITES,
    loading: false,
    loadError: null,
    onRetry: fn(async () => undefined),
    onSaveIdentity: fn(async () => undefined),
    onSetPublished: fn(async () => undefined),
    onCreateInvite: fn(async (input) => ({
      id: "invite-story",
      inviteUrl: "https://team.example.com/invite/story",
      expiresAt: "2026-08-29T10:00:00.000Z",
      role: input.role,
      usedAt: null,
      email: input.email ?? null,
      permanent: input.permanent ?? false,
      useCount: 0,
    })),
    onUpdateMember: fn(async () => undefined),
    onRemoveMember: fn(async () => undefined),
    onRevokeInvite: fn(async () => undefined),
    onOpenScreenRecordingSettings: fn(async () => undefined),
    onRecheckScreenRecording: fn(async () => undefined),
  }) satisfies Omit<ServerSettingsModalProps, "page">;

/** The real Server settings page, with a preview `window.openbot` for the panels that read it. */
export function ServerSettingsStory(props: {
  settings: Omit<ServerSettingsModalProps, "page">;
  hostUpdate?: HostUpdateStatus;
  hostRelease?: HostReleaseStatus;
  migrationPreparationCalls?: OpenBotDesktopApi["migrationPreparation"];
  migrationAssessmentCalls?: OpenBotDesktopApi["migrationAssessment"];
  migrationDestinationPolicyCalls?: OpenBotDesktopApi["migrationDestinationPolicy"];
}) {
  const previous = window.openbot;
  // Each story mount owns one copied mock profile and one selection of bridge overrides.
  const { mock, migrationPreparationCalls, migrationAssessmentCalls, migrationDestinationPolicyCalls } = untrack(() => {
    const hostStatus = props.settings.hostStatus;
    return {
      mock: createMockOpenBot({
        ...(hostStatus ? { hostStatus: snapshot(hostStatus) } : {}),
        ...(props.hostUpdate ? { hostUpdate: props.hostUpdate } : {}),
        ...(props.hostRelease ? { hostRelease: props.hostRelease } : {}),
      }),
      migrationPreparationCalls:
        props.migrationPreparationCalls ??
        injectedMigrationPreparationCalls() ??
        props.settings.migrationPreparation?.calls,
      migrationAssessmentCalls:
        props.migrationAssessmentCalls ??
        injectedMigrationAssessmentCalls() ??
        props.settings.migrationPreparation?.assessmentCalls,
      migrationDestinationPolicyCalls:
        props.migrationDestinationPolicyCalls ??
        injectedMigrationDestinationPolicyCalls() ??
        props.settings.migrationPreparation?.policyCalls,
    };
  });
  window.openbot = mock.api;
  if (migrationPreparationCalls) mock.api.migrationPreparation = migrationPreparationCalls;
  if (migrationAssessmentCalls) mock.api.migrationAssessment = migrationAssessmentCalls;
  if (migrationDestinationPolicyCalls) mock.api.migrationDestinationPolicy = migrationDestinationPolicyCalls;
  const migrationPreparation = createMemo(() => {
    const options = props.settings.migrationPreparation;
    return options
      ? {
          ...options,
          ...(migrationPreparationCalls ? { calls: migrationPreparationCalls } : {}),
          ...(migrationAssessmentCalls ? { assessmentCalls: migrationAssessmentCalls } : {}),
          ...(migrationDestinationPolicyCalls ? { policyCalls: migrationDestinationPolicyCalls } : {}),
        }
      : undefined;
  });
  onSettled(() => () => {
    mock.dispose();
    window.openbot = previous;
  });
  return (
    <SettingsPageStory title="Server settings">
      {(page) => (
        <ServerSettingsModal {...props.settings} migrationPreparation={migrationPreparation()} page={page()} />
      )}
    </SettingsPageStory>
  );
}
