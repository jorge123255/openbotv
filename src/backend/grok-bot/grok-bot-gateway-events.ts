import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { GrokBotGatewaySession } from "./grok-bot-account";

/** BotAI `GATEWAY_EVENTS_PATH` in `source/shared/gateway-wire.ts`. */
export const GROK_BOT_EVENTS_PATH = "/events";
/** BotAI `SSE_STALL_TIMEOUT_MS`. A quiet stream is stalled, not finished. */
export const GROK_BOT_SSE_STALL_MS = 35_000;
/** BotAI `SSE_CONNECT_TIMEOUT_MS`. */
export const GROK_BOT_SSE_CONNECT_MS = 15_000;
/** BotAI `SSE_RECONNECT_MIN_MS` / `SSE_RECONNECT_MAX_MS`. */
export const GROK_BOT_SSE_RECONNECT_MIN_MS = 1_000;
export const GROK_BOT_SSE_RECONNECT_MAX_MS = 10_000;

export interface GrokBotGatewayEvent {
  readonly channel: string;
  readonly payload: unknown;
}

/** One SSE block from the sand gateway. A comment such as `:ping` is not an event. */
export function decodeGatewayEventBlock(block: string): GrokBotGatewayEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (data.length === 0) return null;
  try {
    const parsed = JSON.parse(data);
    if (!isDynamicRecord(parsed) || typeof parsed.channel !== "string" || parsed.channel.length === 0) return null;
    return { channel: parsed.channel, payload: parsed.payload };
  } catch {
    return null;
  }
}

/** Bytes from `GET /events`, split on a blank line the way BotAI's `SseBlockDecoder` splits them. */
export function createSseBlockDecoder(onBlock: (block: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replaceAll("\r\n", "\n");
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (block.length > 0) onBlock(block);
      split = buffer.indexOf("\n\n");
    }
  };
}

export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** BotAI reconnect backoff: 1s, then double, cap 10s, plus up to 30% jitter. */
export function gatewayReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(GROK_BOT_SSE_RECONNECT_MAX_MS, GROK_BOT_SSE_RECONNECT_MIN_MS * 2 ** exponent);
  return Math.round(base + base * 0.3 * random());
}

export function grokBotEventsUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/u, "")}${GROK_BOT_EVENTS_PATH}`;
}

export interface GatewayEventQueue {
  push(event: GrokBotGatewayEvent): void;
  drain(): GrokBotGatewayEvent[];
  readonly size: number;
  wait(signal: AbortSignal): Promise<void>;
}

export function createGatewayEventQueue(): GatewayEventQueue {
  const events: GrokBotGatewayEvent[] = [];
  let waiters: Array<() => void> = [];
  return {
    push(event) {
      events.push(event);
      const pending = waiters;
      waiters = [];
      for (const wake of pending) wake();
    },
    drain() {
      return events.splice(0, events.length);
    },
    get size() {
      return events.length;
    },
    wait(signal) {
      if (events.length > 0) return Promise.resolve();
      return new Promise((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", wake);
          const index = waiters.indexOf(wake);
          if (index >= 0) waiters.splice(index, 1);
          resolve();
        };
        waiters.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    },
  };
}

type StreamRead = "ended" | "stalled" | "aborted" | "unavailable";

export interface GrokBotEventStream {
  /** Resolves when the first response is an event stream, or when that route is absent. */
  readonly ready: Promise<"open" | "unavailable">;
  readonly done: Promise<void>;
}

/**
 * BotAI `streamEvents`: `GET /events`, dispatch each SSE block, stall after 35s, then reconnect.
 * `ready` is `unavailable` when the first response is not an event stream (404, or a JSON body).
 * A later drop reconnects until `signal` aborts.
 */
export function startGrokBotEventStream(options: {
  readonly session: GrokBotGatewaySession;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly stallMs?: number;
  readonly onEvent: (event: GrokBotGatewayEvent) => void;
}): GrokBotEventStream {
  let resolveReady: (value: "open" | "unavailable") => void = () => undefined;
  const ready = new Promise<"open" | "unavailable">((resolve) => {
    resolveReady = resolve;
  });
  let readySettled = false;
  const finishReady = (value: "open" | "unavailable") => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(value);
  };
  const done = runEventLoop(options, finishReady);
  return { ready, done };
}

async function runEventLoop(
  options: {
    readonly session: GrokBotGatewaySession;
    readonly signal: AbortSignal;
    readonly fetchImpl?: typeof fetch;
    readonly stallMs?: number;
    readonly onEvent: (event: GrokBotGatewayEvent) => void;
  },
  finishReady: (value: "open" | "unavailable") => void,
): Promise<void> {
  let attempt = 0;
  while (!options.signal.aborted) {
    try {
      const result = await readEventStream(options, () => finishReady("open"));
      if (result === "unavailable") {
        finishReady("unavailable");
        return;
      }
      if (result === "aborted" || options.signal.aborted) return;
      finishReady("open");
      attempt = 0;
    } catch {
      if (options.signal.aborted) return;
      attempt += 1;
    }
    if (options.signal.aborted) return;
    try {
      await sleepWithSignal(gatewayReconnectDelayMs(Math.max(attempt, 1)), options.signal);
    } catch {
      return;
    }
  }
}

async function readEventStream(
  options: {
    readonly session: GrokBotGatewaySession;
    readonly signal: AbortSignal;
    readonly fetchImpl?: typeof fetch;
    readonly stallMs?: number;
    readonly onEvent: (event: GrokBotGatewayEvent) => void;
  },
  onOpen: () => void,
): Promise<StreamRead> {
  const local = new AbortController();
  const onCallerAbort = () => local.abort();
  options.signal.addEventListener("abort", onCallerAbort, { once: true });
  let stalled = false;
  const stallMs = options.stallMs ?? GROK_BOT_SSE_STALL_MS;
  let timer = setTimeout(() => {
    stalled = true;
    local.abort();
  }, stallMs);
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      local.abort();
    }, stallMs);
  };
  const call = options.fetchImpl ?? fetch;
  try {
    const response = await call(grokBotEventsUrl(options.session.url), {
      method: "GET",
      redirect: "manual",
      signal: local.signal,
      headers: {
        accept: "text/event-stream",
        Authorization: `Bearer ${options.session.token}`,
        ...options.session.headers,
      },
    });
    if (options.signal.aborted) return "aborted";
    if (!response.ok || response.body == null) {
      if (response.status === 404 || response.status === 405 || response.status === 501) return "unavailable";
      throw new Error(`gateway events HTTP ${response.status}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      await response.body.cancel().catch(() => undefined);
      return "unavailable";
    }
    onOpen();
    kick();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const push = createSseBlockDecoder((block) => {
      const event = decodeGatewayEventBlock(block);
      if (event) options.onEvent(event);
    });
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) return "ended";
        kick();
        push(decoder.decode(result.value, { stream: true }));
      }
    } catch (error) {
      if (options.signal.aborted) return "aborted";
      if (stalled) return "stalled";
      throw error;
    }
  } catch (error) {
    if (options.signal.aborted) return "aborted";
    if (stalled) return "stalled";
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onCallerAbort);
  }
}
