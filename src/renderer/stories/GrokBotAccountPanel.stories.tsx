import { GrokBotAccountPanel } from "@openbot/ui/features/grok-bot/GrokBotAccountPanel";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const meta = {
  title: "Servers/Grok Bot account",
  component: GrokBotAccountPanel,
} satisfies Meta<typeof GrokBotAccountPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

const idle = {
  busy: false,
  error: null,
  onSignIn: () => undefined,
  onSignOut: () => undefined,
  onRefresh: () => undefined,
  onCreate: () => undefined,
  usage: null,
  onChangeLimit: () => undefined,
  onTrial: () => undefined,
};

export const SignedOut: Story = {
  args: {
    ...idle,
    signedIn: false,
    agents: [],
  },
};

export const SignedIn: Story = {
  args: {
    ...idle,
    signedIn: true,
    agents: [
      {
        id: "visible",
        name: "Research",
        title: "",
        description: "Reads the notes.",
        hidden: false,
        room: false,
      },
      {
        id: "hidden",
        name: "Hidden",
        title: "",
        description: "This row stays out of the list.",
        hidden: true,
        room: false,
      },
    ],
  },
};
