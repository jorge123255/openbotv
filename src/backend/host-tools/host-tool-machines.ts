import { hostname } from "node:os";
import type { ListedMachine } from "./host-tool-types";
import { DEFAULT_COMPUTER_ID } from "./local-exec-frames";

/**
 * This process is the local-exec daemon for one computer.
 * BotAI addresses another computer by routing to the subscriber that sent that
 * computerId. OpenBot has no second submit route. A different id stays unavailable.
 */
export function thisComputer(host = hostname()): ListedMachine {
  const trimmed = host.trim();
  if (trimmed.length === 0) {
    return { id: DEFAULT_COMPUTER_ID, label: "this computer", connected: true };
  }
  return { id: trimmed, label: trimmed, connected: true };
}
