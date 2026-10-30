import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { GrokBotVncProxy } from "./grok-bot-account";

/**
 * Grok Bot computer: the sand "forever box", a Linux desktop the sand agents drive with computer use.
 * Ported from BotAI 0.27 (`source/node-agent-coordinator/gateway/box-vnc-proxy.ts`,
 * `source/packages/constants/sand-box.ts`, `frontend/src/production/model.ts#projectComputerStatus`).
 *
 * The box reports its screen as a loopback noVNC page. `EnsureSandBox` returns `vncUrl` (primary
 * display, already proxied) and `forkVncBaseUrl` (fork displays) plus a network token; the token
 * rides in the viewer URL and in the `x-anyrun-network-token` header of every viewer request.
 */

export const SAND_BOX_PRIMARY_NOVNC_PORT = 6080;
export const SAND_BOX_FORK_NOVNC_PORT = 6081;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const WAKE = "resume_lower_s=900&resume_upper_s=18000";

export type GrokBotComputerPhase = "off" | "starting" | "sleeping" | "local" | "running" | "pulling";

/** Main-process view. `vncUrl` carries the network token and never goes to the renderer. */
export interface GrokBotComputerStatus {
  phase: GrokBotComputerPhase;
  vncUrl: string | null;
  networkToken: string | null;
  pullPercent: number | null;
  imageUpdateAvailable: boolean;
  /** The agent that handed the computer to the person ("Take over the computer"), if any. */
  handoffAgentId: string | null;
  handoffReason: string | null;
}

export function buildSandBoxNoVncUrl(proxyBaseUrl: string, networkToken: string, token?: string): string {
  const tokenParam = token === undefined ? "" : `token=${encodeURIComponent(token)}&`;
  const websockifyPath = `websockify?${tokenParam}network_token=${encodeURIComponent(networkToken)}&${WAKE}`;
  return `${stripTrailingSlash(proxyBaseUrl)}/vnc.html?network_token=${encodeURIComponent(networkToken)}&${WAKE}&path=${encodeURIComponent(websockifyPath)}`;
}

/** The `vncProxy` descriptor from `EnsureSandBox` fields, or null when the broker exposes no screen. */
export function buildGrokBotVncProxy(
  vncUrl: string | null,
  forkVncBaseUrl: string | null,
  networkToken: string | null,
): GrokBotVncProxy | null {
  if (!vncUrl || !forkVncBaseUrl || !networkToken) return null;
  if (!isAllowedViewerUrl(vncUrl) || !isAllowedViewerUrl(forkVncBaseUrl)) return null;
  return { primaryUrl: vncUrl, forkBaseUrl: stripTrailingSlash(forkVncBaseUrl), networkToken };
}

/** BotAI `proxifyBoxVncUrl`: loopback noVNC → the public box proxy. Other URLs pass through. */
export function proxifyBoxVncUrl(vncUrl: string, proxy: GrokBotVncProxy): string {
  let parsed: URL;
  try {
    parsed = new URL(vncUrl);
  } catch {
    return vncUrl;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith("/vnc.html")) return vncUrl;
  const port = Number.parseInt(parsed.port, 10);
  if (port === SAND_BOX_PRIMARY_NOVNC_PORT) return proxy.primaryUrl;
  if (port === SAND_BOX_FORK_NOVNC_PORT)
    return buildSandBoxNoVncUrl(proxy.forkBaseUrl, proxy.networkToken, forkDisplayToken(parsed));
  return vncUrl;
}

/** BotAI `projectComputerStatus` over a `getForeverBoxStatus` / `ensureForeverBox` reply. */
export function parseGrokBotComputerStatus(value: unknown, proxy: GrokBotVncProxy | null): GrokBotComputerStatus {
  const empty: GrokBotComputerStatus = {
    phase: "off",
    vncUrl: null,
    networkToken: null,
    pullPercent: null,
    imageUpdateAvailable: false,
    handoffAgentId: null,
    handoffReason: null,
  };
  if (!isDynamicRecord(value)) return empty;
  const reported = typeof value.vncUrl === "string" && value.vncUrl.length > 0 ? value.vncUrl : null;
  const proxied = reported && proxy ? proxifyBoxVncUrl(reported, proxy) : reported;
  // A loopback URL left unproxied points at this Mac, not the box; never open it.
  const vncUrl = proxied && isAllowedViewerUrl(proxied) ? proxied : null;
  const pull = isDynamicRecord(value.pull) ? value.pull : null;
  const phase: GrokBotComputerPhase =
    pull !== null
      ? "pulling"
      : value.state === "running"
        ? vncUrl === null
          ? "local"
          : "running"
        : value.state === "hibernated"
          ? "sleeping"
          : value.state === "starting" || value.state === "creating"
            ? "starting"
            : "off";
  const handoff = isDynamicRecord(value.handoff) ? value.handoff : null;
  return {
    phase,
    vncUrl,
    networkToken: vncUrl ? (proxy?.networkToken ?? new URL(vncUrl).searchParams.get("network_token")) : null,
    pullPercent: pull !== null && typeof pull.percent === "number" ? pull.percent : null,
    imageUpdateAvailable: value.imageUpdateAvailable === true,
    handoffAgentId: handoff ? textOrNull(handoff.agentId ?? handoff.id) : null,
    handoffReason: handoff ? textOrNull(handoff.reason ?? handoff.message ?? handoff.title) : null,
  };
}

/** https only, no credentials in the URL. A loopback screen is never opened from OpenBot. */
export function isAllowedViewerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:";
}

function forkDisplayToken(parsed: URL): string | undefined {
  const path = parsed.searchParams.get("path");
  const queryIndex = path?.indexOf("?") ?? -1;
  if (path == null || queryIndex < 0) return undefined;
  const token = new URLSearchParams(path.slice(queryIndex + 1)).get("token");
  return token != null && token.length > 0 ? token : undefined;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}
