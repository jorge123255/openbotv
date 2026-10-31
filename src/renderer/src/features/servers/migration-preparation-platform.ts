import type { AppInfo } from "@openbot/contracts/ipc";

/** The signal must be read first: the host-confirmation flag is a plain value. */
export function migrationPreparationHostConfirmed(platform: {
  appInfo: () => AppInfo | null;
  appInfoLoadedFromHost: () => boolean;
}): boolean {
  const info = platform.appInfo();
  return Boolean(info && platform.appInfoLoadedFromHost());
}
