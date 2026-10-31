import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export function ollamaQuotaPort(): Pick<OpenBotDesktopApi, "ollamaQuota"> {
  return window.openbot;
}
