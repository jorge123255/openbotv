import type { ConversationProps } from "./conversation-types";

/**
 * A Grok Bot agent chat on this computer. Its side panel opens the sand computer.
 * A joined server and a channel keep the ordinary panes.
 */
export function grokBotDesktopChat(props: Pick<ConversationProps, "agent" | "runtime" | "channel">): boolean {
  return props.agent?.provider === "grok-bot" && props.runtime === undefined && props.channel === undefined;
}
