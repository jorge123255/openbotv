import { runCauseEffect } from "../../backend/effect-boundary";
import type { KimiCliUsageService } from "../kimi-cli-usage-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { parseKimiCliUsageConnection, parseKimiCliUsageConsent } from "./kimi-cli-usage-inputs";

export interface KimiCliUsageIpcDependencies {
  kimiCliUsage: KimiCliUsageService;
}
export function kimiCliUsageIpcHandlers({
  kimiCliUsage,
}: KimiCliUsageIpcDependencies): Pick<IpcGroupHandlers, "kimiCliUsage"> {
  return {
    kimiCliUsage: {
      get: handler(() => kimiCliUsage.get()),
      connect: payloadHandler(parseKimiCliUsageConnection, (input) => runCauseEffect(kimiCliUsage.connect(input))),
      read: payloadHandler(parseKimiCliUsageConsent, () => runCauseEffect(kimiCliUsage.read())),
      disconnect: handler(() => kimiCliUsage.disconnect()),
    },
  };
}
