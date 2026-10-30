import type { GrokBotRuntimeInfo } from "../cli";

/**
 * Grok Bot does not download a CLI. `remote` is the marker. It is not in `MANAGED_RUNTIME_PROVIDERS`,
 * so the runtime manager does not fetch a binary.
 */
export const GROK_BOT_RUNTIME: GrokBotRuntimeInfo = {
  executable: "",
  version: "remote",
  remote: true,
};
