import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Schema } from "effect";
import type {
  GrokBotBoxComputer,
  GrokBotBoxComputerAction,
  GrokBotBoxComputerActionValue,
  GrokBotBoxComputerRequest,
  GrokBotBoxComputerResult,
  GrokBotBoxCoordinate,
} from "./grok-bot-box-computer";

/**
 * Loopback lifecycle for the Grok Bot box computer.
 *
 * Ported from BotAI `startBoxExecDaemon` (`source/box-exec-daemon/server.ts`) for the
 * computer-control routes only. Shell, file read, and MCP stay on the sand host.
 * Plan #32 owns the host-tool runner. The server listens on loopback only.
 * Its bearer token is a new random secret, or `SAND_BOX_EXEC_DAEMON_AUTH_TOKEN` when that value is set.
 * The literal word `local` is never accepted.
 */

const BOX_EXEC_DAEMON_HOST = "127.0.0.1";
const BOX_EXEC_DAEMON_PORT = 1337;
export const BOX_EXEC_DAEMON_AUTH_TOKEN_ENV = "SAND_BOX_EXEC_DAEMON_AUTH_TOKEN";
/** BotAI's old loopback default. This server rejects it on every host. */
const FORBIDDEN_BOX_EXEC_AUTH_TOKEN = "local";

const BODY_LIMIT = 1024 * 1024;

class GrokBotBoxExecFailed extends Schema.TaggedError<GrokBotBoxExecFailed>()("GrokBotBoxExecFailed", {
  cause: Schema.Defect(),
}) {}

export interface GrokBotBoxExecOptions {
  readonly computer: GrokBotBoxComputer;
  readonly host?: string;
  readonly port?: number;
  /** Caller secret. When absent, the env secret is used, then a new random secret. */
  readonly authToken?: string;
  /** Token lookup only. When set, process env is not read. */
  readonly environment?: NodeJS.ProcessEnv;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/** Constant-time check of `Authorization: Bearer <token>`. */
export function authorizationMatches(presented: string | string[] | undefined, token: string): boolean {
  if (typeof presented !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const candidate = Buffer.from(presented);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export class GrokBotBoxExec {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Bearer secret for this process. Do not log it. */
  readonly authToken: string;
  readonly computerUseSupported: boolean;
  readonly #server: Server;
  #stopped = false;

  constructor(server: Server, host: string, port: number, authToken: string, computerUseSupported: boolean) {
    this.#server = server;
    this.host = host;
    this.port = port;
    this.url = `http://${host}:${port}`;
    this.authToken = authToken;
    this.computerUseSupported = computerUseSupported;
  }

  /** Teardown. Does not wait. `stop` waits until the port is released. */
  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#server.close();
  }

  readonly stop = Effect.fn("GrokBotBoxExec.stop")(function* (this: GrokBotBoxExec) {
    if (this.#stopped) return;
    this.#stopped = true;
    yield* Effect.tryPromise({
      try: () => closeServer(this.#server),
      catch: (cause) => new GrokBotBoxExecFailed({ cause }),
    });
  });
}

export const startGrokBotBoxExec = Effect.fn("GrokBotBoxExec.start")(function* (options: GrokBotBoxExecOptions) {
  const host = options.host ?? BOX_EXEC_DAEMON_HOST;
  const port = options.port ?? BOX_EXEC_DAEMON_PORT;
  if (!isLoopbackHost(host)) {
    return yield* Effect.fail(
      new GrokBotBoxExecFailed({
        cause: new Error(
          `Refusing to bind the box exec daemon to ${host}. The computer server listens on loopback only.`,
        ),
      }),
    );
  }
  const authToken = resolveBoxExecAuthToken(options);
  if (authToken == null) {
    return yield* Effect.fail(
      new GrokBotBoxExecFailed({
        cause: new Error('Refusing the box exec token "local". Set a different secret, or leave it unset.'),
      }),
    );
  }
  registerSecretValue(authToken);
  const computer = options.computer;
  const server = createServer((request, response) => {
    void handle(request, response, computer, authToken);
  });
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    catch: (cause) => new GrokBotBoxExecFailed({ cause }),
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    server.close();
    return yield* Effect.fail(
      new GrokBotBoxExecFailed({
        cause: new Error("Box exec daemon did not expose a TCP address."),
      }),
    );
  }
  return new GrokBotBoxExec(server, host, address.port, authToken, computer.configured);
});

/** A set secret, or a new random secret. The literal `local` is refused. */
function resolveBoxExecAuthToken(options: GrokBotBoxExecOptions): string | null {
  const environment = options.environment ?? process.env;
  const explicit = options.authToken?.trim() ?? "";
  const fromEnv = environment[BOX_EXEC_DAEMON_AUTH_TOKEN_ENV]?.trim() ?? "";
  const provided = explicit.length > 0 ? explicit : fromEnv;
  if (provided === FORBIDDEN_BOX_EXEC_AUTH_TOKEN) return null;
  if (provided.length > 0) return provided;
  return randomBytes(32).toString("base64url");
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  computer: GrokBotBoxComputer,
  authToken: string,
): Promise<void> {
  if (!authorizationMatches(request.headers.authorization, authToken)) {
    request.resume();
    response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    response.end("Unauthorized");
    return;
  }
  const path = request.url?.split("?")[0] ?? "";
  if (request.method !== "POST" || (path !== "/ping" && path !== "/capabilities" && path !== "/computer")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (path === "/ping") {
    json(response, 200, { service: "box-exec" });
    return;
  }
  if (path === "/capabilities") {
    json(response, 200, { computerUseSupported: computer.configured });
    return;
  }
  const body = await readBody(request);
  if (body == null) {
    response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
    response.end("Body too large");
    return;
  }
  let parsed: GrokBotBoxComputerRequest;
  try {
    parsed = decodeRequest(JSON.parse(body));
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }
  const result = await Effect.runPromise(computer.execute(parsed));
  json(response, 200, result);
}

function decodeRequest(value: unknown): GrokBotBoxComputerRequest {
  if (!isDynamicRecord(value) || !Array.isArray(value.actions)) throw new Error("Computer request has no actions.");
  return { actions: value.actions.map(decodeAction) };
}

function decodeAction(value: unknown): GrokBotBoxComputerAction {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.action)) throw new Error("Computer action has no case.");
  const action = value.action;
  return {
    action: {
      ...(typeof action.case === "string" ? { case: action.case } : {}),
      value: decodeValue(action.value),
    },
  };
}

function decodeValue(value: unknown): GrokBotBoxComputerActionValue {
  if (!isDynamicRecord(value)) return {};
  const coordinate = decodeCoordinate(value.coordinate);
  const path = Array.isArray(value.path) ? value.path.flatMap(presentCoordinate) : undefined;
  return {
    ...(coordinate == null ? {} : { coordinate }),
    ...(path == null ? {} : { path }),
    ...(typeof value.button === "number" ? { button: value.button } : {}),
    ...(typeof value.count === "number" ? { count: value.count } : {}),
    ...(typeof value.modifierKeys === "string" ? { modifierKeys: value.modifierKeys } : {}),
    ...(typeof value.direction === "number" ? { direction: value.direction } : {}),
    ...(typeof value.amount === "number" ? { amount: value.amount } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.key === "string" ? { key: value.key } : {}),
    ...(typeof value.holdDurationMs === "number" ? { holdDurationMs: value.holdDurationMs } : {}),
    ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
  };
}

function decodeCoordinate(value: unknown): GrokBotBoxCoordinate | undefined {
  if (!isDynamicRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") return undefined;
  return { x: value.x, y: value.y };
}

function presentCoordinate(value: unknown): GrokBotBoxCoordinate[] {
  const coordinate = decodeCoordinate(value);
  return coordinate == null ? [] : [coordinate];
}

type BoxExecJson =
  | GrokBotBoxComputerResult
  | { readonly computerUseSupported: boolean }
  | { readonly service: "box-exec" };

function json(response: ServerResponse, status: number, body: BoxExecJson): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error == null ? resolve() : reject(error)));
  });
}
