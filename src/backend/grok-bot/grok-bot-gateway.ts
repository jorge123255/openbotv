import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import {
  GrokBotAccountFailed,
  type GrokBotAccountRecord,
  type GrokBotAccountStore,
  type GrokBotGatewaySession,
} from "./grok-bot-account";

/** `grokbot_api` 1.2.0 `DEFAULT_CLIENT_VERSION`. This is a header, not a protocol registration. */
export const GROK_BOT_CURSOR_CLIENT_VERSION = "0.70.2";
const BODY_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const DEFAULT_API_BASE_URL = "https://api2.cursor.sh";

export interface GrokBotAgentSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  hidden: boolean;
  room: boolean;
}

export interface CreateGrokBotAgentInput {
  name: string;
  description: string;
}

export interface GrokBotGatewayCallOptions {
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
  allowLoopback?: boolean;
}

export const listGrokBotAgents = Effect.fn("GrokBotGateway.list")(function* (
  store: GrokBotAccountStore,
  options: GrokBotGatewayCallOptions,
) {
  const body = yield* gatewayJson(store, options, "/api/listAgents", {});
  return parseAgents(body);
});

export const createGrokBotAgent = Effect.fn("GrokBotGateway.create")(function* (
  store: GrokBotAccountStore,
  input: CreateGrokBotAgentInput,
  options: GrokBotGatewayCallOptions,
) {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 80)
    return yield* Effect.fail(accountFailure("error.provider.grokBotNameRequired"));
  if (input.description.length > 2000) return yield* Effect.fail(accountFailure("error.provider.grokBotAgentRejected"));
  const body = yield* gatewayJson(store, options, "/api/createAgent", {
    name,
    description: input.description,
    title: "",
    avatarShape: "",
    avatarColor: "",
    origin: "user",
  });
  const created = parseCreated(body);
  if (!created) return yield* Effect.fail(accountFailure("error.provider.grokBotAgentRejected"));
  return created;
});

const gatewayJson = Effect.fn("GrokBotGateway.call")(function* (
  store: GrokBotAccountStore,
  options: GrokBotGatewayCallOptions,
  path: string,
  body: unknown,
) {
  let record = yield* store.load();
  if (!record) return yield* Effect.fail(accountFailure("error.provider.grokBotNotSignedIn"));
  if (!record.gateway) record = yield* ensureSandbox(store, options);
  let response = yield* postSession(record.gateway, path, body, options.fetchImpl);
  if (response.status === 401 || response.status === 417) {
    record = yield* ensureSandbox(store, options);
    response = yield* postSession(record.gateway, path, body, options.fetchImpl);
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(accountFailure("error.provider.grokBotSessionEnded"));
  }
  return yield* readJson(response);
});

const ensureSandbox = Effect.fn("GrokBotGateway.ensure")(function* (
  store: GrokBotAccountStore,
  options: GrokBotGatewayCallOptions,
) {
  let record = yield* store.load();
  if (!record) return yield* Effect.fail(accountFailure("error.provider.grokBotNotSignedIn"));
  let response = yield* postEnsure(record.accessToken, options);
  if (response.status === 401) {
    const refreshed = yield* store.refreshAccess(options);
    if (!refreshed) return yield* Effect.fail(accountFailure("error.provider.grokBotSessionEnded"));
    record = refreshed;
    response = yield* postEnsure(record.accessToken, options);
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(accountFailure("error.provider.grokBotSessionEnded"));
  }
  const body = yield* readJson(response);
  const gateway = parseGatewaySession(body, options.allowLoopback === true);
  if (!gateway) return yield* Effect.fail(accountFailure("error.provider.grokBotSessionEnded"));
  registerSecretValue(gateway.token);
  for (const value of Object.values(gateway.headers)) registerSecretValue(value);
  const next: GrokBotAccountRecord = { ...record, gateway };
  yield* store.save(next);
  return next;
});

function postEnsure(accessToken: string, options: GrokBotGatewayCallOptions) {
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  return Effect.tryPromise({
    try: () =>
      fetchImpl(new URL("/aiserver.v1.GrokBotService/EnsureSandBox", apiBaseUrl), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "connect-protocol-version": "1",
          "x-cursor-client-type": "sand",
          "x-cursor-client-version": GROK_BOT_CURSOR_CLIENT_VERSION,
          "x-sand-box-namespace": "prod",
        },
        body: "{}",
      }),
    catch: () => accountFailure("error.provider.grokBotSessionEnded"),
  });
}

function postSession(
  session: GrokBotGatewaySession | null,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch | undefined,
) {
  if (!session) return Effect.fail(accountFailure("error.provider.grokBotSessionEnded"));
  const call = fetchImpl ?? fetch;
  return Effect.tryPromise({
    try: () =>
      call(new URL(path, session.url), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
          ...session.headers,
        },
        body: JSON.stringify(body),
      }),
    catch: () => accountFailure("error.provider.grokBotSessionEnded"),
  });
}

function readJson(response: Response) {
  return Effect.tryPromise({
    try: async () => {
      const text = await response.text();
      if (text.length > BODY_LIMIT) throw new Error(sourceText("error.provider.grokBotSessionEnded"));
      return text.length === 0 ? {} : JSON.parse(text);
    },
    catch: () => accountFailure("error.provider.grokBotSessionEnded"),
  });
}

function parseGatewaySession(value: unknown, allowLoopback: boolean): GrokBotGatewaySession | null {
  if (!isDynamicRecord(value)) return null;
  const url = stringField(value, "gatewayUrl", "gateway_url");
  const token = stringField(value, "gatewayToken", "gateway_token");
  if (!url || !token || !acceptGatewayUrl(url, allowLoopback)) return null;
  const headers = headerMap(value.gatewayHeaders ?? value.gateway_headers);
  const anyrun = stringField(value, "anyrunNetworkToken", "anyrun_network_token", "networkToken");
  if (anyrun && headers["x-anyrun-network-token"] === undefined) headers["x-anyrun-network-token"] = anyrun;
  return { url, token, headers };
}

function acceptGatewayUrl(value: string, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (allowLoopback && url.hostname === "127.0.0.1") return url.protocol === "http:" || url.protocol === "https:";
  if (url.protocol !== "https:") return false;
  return url.hostname === "cursorvm.com" || url.hostname.endsWith(".cursorvm.com");
}

function parseAgents(value: unknown): readonly GrokBotAgentSummary[] {
  const rows = Array.isArray(value)
    ? value
    : isDynamicRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : isDynamicRecord(value) && value.agent !== undefined
        ? [value.agent]
        : [];
  const agents: GrokBotAgentSummary[] = [];
  for (const row of rows) {
    const agent = parseAgent(row);
    if (agent) agents.push(agent);
  }
  return agents;
}

function parseCreated(value: unknown): GrokBotAgentSummary | null {
  const row = isDynamicRecord(value) && value.agent !== undefined ? value.agent : value;
  return parseAgent(row);
}

function parseAgent(value: unknown): GrokBotAgentSummary | null {
  if (!isDynamicRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : typeof value.agentId === "string" ? value.agentId : "";
  if (id.length === 0) return null;
  const members = value.memberIds ?? value.memberAgentIds;
  const room = typeof value.isGroup === "boolean" ? value.isGroup : Array.isArray(members) && members.length > 0;
  const hiddenFlag = value.isHiddenFromSidebar ?? value.hiddenFromSidebar;
  return {
    id,
    name: typeof value.name === "string" ? value.name : "",
    title: typeof value.title === "string" ? value.title : "",
    description: typeof value.description === "string" ? value.description : "",
    hidden: hiddenFlag === true,
    room,
  };
}

function headerMap(value: unknown): Record<string, string> {
  if (!isDynamicRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header === "string") headers[name] = header;
  }
  return headers;
}

function stringField(value: DynamicRecord, ...names: string[]): string | null {
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return null;
}

function accountFailure(
  key:
    | "error.provider.grokBotNameRequired"
    | "error.provider.grokBotAgentRejected"
    | "error.provider.grokBotNotSignedIn"
    | "error.provider.grokBotSessionEnded",
): GrokBotAccountFailed {
  return new GrokBotAccountFailed({ cause: new Error(sourceText(key)) });
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}
