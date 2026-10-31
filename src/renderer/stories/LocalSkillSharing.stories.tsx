import type { InstalledSkill, MarketplaceSkillDetail } from "@openbot/contracts/ipc";
import { onSettled } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentSkillsModal } from "../src/features/conversation/AgentSkillsModal";
import { createMockOpenBot } from "./mock-openbot";

const skill: MarketplaceSkillDetail = {
  id: "local-skill-11111111-1111-4111-8111-111111111111",
  slug: "change-review",
  name: "Change review",
  description: "Review a proposed change and list the checks that support it.",
  category: "coding",
  creatorName: "Local",
  version: 1,
  versionId: "1",
  installs: 0,
  featured: false,
  iconUrl: null,
  updatedAt: "2026-10-31T00:00:00.000Z",
  bundleSha256: "a".repeat(64),
  files: ["SKILL.md"],
  instructions:
    "Read the proposed change.\nCheck its effect on user data and permissions.\nReport the checks and any limits.\n",
};
function LocalLibraryStory() {
  const previous = window.openbot;
  const modified: InstalledSkill = {
    skillId: skill.id,
    slug: skill.slug,
    name: skill.name,
    installedVersion: 1,
    availableVersion: 1,
    state: "modified",
    origin: "local",
    enabled: true,
  };
  const mock = createMockOpenBot({
    localSkills: [skill],
    installedSkills: { chief: [], research: [modified] },
    skillShareRecipients: [
      { agentId: "chief", name: "Chief" },
      { agentId: "research", name: "Research" },
      { agentId: "planner", name: "Planner" },
    ],
  });
  window.openbot = mock.api;
  onSettled(() => () => {
    mock.dispose();
    window.openbot = previous;
  });
  return (
    <AgentSkillsModal
      agentId="chief"
      agentName="Chief"
      open={true}
      onOpenChange={() => {}}
      onCountChange={() => {}}
      selectionRequest={{ skillId: skill.id }}
    />
  );
}
const meta = {
  title: "Settings/Local Skill Sharing",
  component: AgentSkillsModal,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof AgentSkillsModal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewAndSelect: Story = { render: () => <LocalLibraryStory /> };
