import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
export type HermesGatewayPort = OpenBotDesktopApi["hermesGateways"];
export function hermesGatewayPort(): HermesGatewayPort {
  return window.openbot.hermesGateways;
}
