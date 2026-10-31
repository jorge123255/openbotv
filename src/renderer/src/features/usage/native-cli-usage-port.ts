import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export function nativeCliUsagePort(): Pick<OpenBotDesktopApi, "kimiCliUsage"> {
  return window.openbot;
}
