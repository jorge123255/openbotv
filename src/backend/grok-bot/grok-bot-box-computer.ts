import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";

/**
 * Computer control for the Grok Bot sand desktop.
 *
 * Ported from BotAI `source/box-exec-daemon/cua-computer.ts`. The box driver is
 * `cua-driver call`, on the box session, with the box display `:1`. One batch
 * runs at a time. A failure comes back as an error result. It does not throw.
 */

const BOX_CUA_DRIVER_PATH_ENV = "SAND_CUA_DRIVER_PATH";
const BOX_CUA_SOCKET_ENV = "SAND_CUA_SOCKET";
const BOX_CUA_SESSION_ENV = "SAND_CUA_SESSION";
const DEFAULT_BOX_CUA_DRIVER_PATH = "/usr/local/libexec/botai/cua-driver";
const DEFAULT_BOX_CUA_SOCKET = "/run/user/1000/botai-cua.sock";
const DEFAULT_BOX_CUA_SESSION = "botai-box";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 20_000;
const XDOTOOL_TIMEOUT_MS = 10_000;

interface BoxDriverCall {
  readonly x?: number;
  readonly y?: number;
  readonly scope?: "desktop";
  readonly session?: string;
  readonly keys?: readonly string[];
  readonly button?: "left" | "right" | "middle";
  readonly count?: number;
  readonly from_x?: number;
  readonly from_y?: number;
  readonly to_x?: number;
  readonly to_y?: number;
  readonly duration_ms?: number;
  readonly modifier?: readonly string[];
  readonly direction?: "up" | "down" | "left" | "right";
  readonly amount?: number;
  readonly by?: "line";
  readonly text?: string;
  readonly key?: string;
}

export interface GrokBotBoxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GrokBotBoxCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
) => Promise<GrokBotBoxCommandResult>;

export interface GrokBotBoxComputerOptions {
  readonly executable?: string;
  readonly socket?: string;
  readonly session?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: GrokBotBoxCommandRunner;
  readonly temporaryDirectory?: string;
}

export interface GrokBotBoxCoordinate {
  readonly x: number;
  readonly y: number;
}

/** One `ComputerUseArgs` action. `case` and `value` match BotAI's protobuf oneof. */
export interface GrokBotBoxComputerAction {
  readonly action: {
    readonly case?: string;
    readonly value?: GrokBotBoxComputerActionValue;
  };
}

export interface GrokBotBoxComputerActionValue {
  readonly coordinate?: GrokBotBoxCoordinate;
  readonly path?: readonly GrokBotBoxCoordinate[];
  readonly button?: number;
  readonly count?: number;
  readonly modifierKeys?: string;
  readonly direction?: number;
  readonly amount?: number;
  readonly text?: string;
  readonly key?: string;
  readonly holdDurationMs?: number;
  readonly durationMs?: number;
}

export interface GrokBotBoxComputerRequest {
  readonly actions: readonly GrokBotBoxComputerAction[];
}

interface GrokBotBoxComputerSuccess {
  readonly actionCount: number;
  readonly durationMs: number;
  readonly screenshot?: string;
  readonly cursorPosition?: GrokBotBoxCoordinate;
  readonly log?: string;
}

export type GrokBotBoxComputerResult =
  | { readonly result: { readonly case: "success"; readonly value: GrokBotBoxComputerSuccess } }
  | {
      readonly result: {
        readonly case: "error";
        readonly value: { readonly error: string; readonly actionCount: number; readonly durationMs: number };
      };
    };

export class GrokBotBoxComputer {
  readonly #executable: string;
  readonly #socket: string;
  readonly #session: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runner: GrokBotBoxCommandRunner;
  readonly #temporaryDirectory: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: GrokBotBoxComputerOptions = {}) {
    const environment = options.environment ?? process.env;
    this.#executable =
      options.executable ?? environment[BOX_CUA_DRIVER_PATH_ENV]?.trim() ?? DEFAULT_BOX_CUA_DRIVER_PATH;
    this.#socket = options.socket ?? environment[BOX_CUA_SOCKET_ENV]?.trim() ?? DEFAULT_BOX_CUA_SOCKET;
    this.#session = options.session ?? environment[BOX_CUA_SESSION_ENV]?.trim() ?? DEFAULT_BOX_CUA_SESSION;
    this.#environment = {
      ...environment,
      CUA_DRIVER_INSTALL_CHANNEL: "python_package",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    };
    this.#runner = options.runner ?? defaultRunner;
    this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  }

  /** True when this process can see the box driver binary and its socket path. */
  get configured(): boolean {
    return this.#executable.length > 0 && this.#socket.length > 0 && existsSync(this.#executable);
  }

  readonly execute = Effect.fn("GrokBotBoxComputer.execute")(function* (
    this: GrokBotBoxComputer,
    request: GrokBotBoxComputerRequest,
  ) {
    // Expected driver failures stay inside the result. This promise only rejects on a defect.
    return yield* Effect.promise(() => this.#execute(request));
  });

  async #execute(request: GrokBotBoxComputerRequest): Promise<GrokBotBoxComputerResult> {
    const startedAt = Date.now();
    let release: () => void = () => undefined;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let actionCount = 0;
      let screenshot: string | undefined;
      let cursorPosition: GrokBotBoxCoordinate | undefined;
      const log: string[] = [];
      for (const entry of request.actions) {
        const action = entry.action;
        const value = action.value ?? {};
        switch (action.case) {
          case "mouseMove": {
            const coordinate = value.coordinate;
            if (coordinate == null) throw new Error("mouseMove requires a coordinate.");
            await this.#call("move_cursor", {
              x: coordinate.x,
              y: coordinate.y,
              scope: "desktop",
              session: this.#session,
            });
            break;
          }
          case "click": {
            const coordinate = value.coordinate;
            const modifiers = parseModifiers(value.modifierKeys);
            if (modifiers.length > 0) {
              await this.#call("hotkey", { keys: modifiers, scope: "desktop", session: this.#session });
            }
            await this.#call("click", {
              ...(coordinate == null ? {} : { x: coordinate.x, y: coordinate.y }),
              button: mouseButton(value.button),
              count: Math.max(1, value.count || 1),
              scope: "desktop",
              session: this.#session,
            });
            break;
          }
          case "mouseDown":
            await this.#xdotool(["mousedown", xdotoolButton(value.button)]);
            break;
          case "mouseUp":
            await this.#xdotool(["mouseup", xdotoolButton(value.button)]);
            break;
          case "drag": {
            const first = value.path?.[0];
            const last = value.path?.at(-1);
            if (first == null || last == null) throw new Error("drag requires at least one path coordinate.");
            await this.#call("drag", {
              from_x: first.x,
              from_y: first.y,
              to_x: last.x,
              to_y: last.y,
              duration_ms: Math.max(100, (value.path?.length ?? 0) * 75),
              button: mouseButton(value.button),
              modifier: parseModifiers(value.modifierKeys),
              scope: "desktop",
              session: this.#session,
            });
            break;
          }
          case "scroll": {
            const coordinate = value.coordinate ?? (await this.#cursorPosition());
            await this.#call("scroll", {
              x: coordinate.x,
              y: coordinate.y,
              direction: scrollDirection(value.direction),
              amount: Math.max(1, value.amount || 1),
              by: "line",
              scope: "desktop",
              session: this.#session,
            });
            break;
          }
          case "type":
            await this.#call("type_text", { text: value.text ?? "", scope: "desktop", session: this.#session });
            break;
          case "key": {
            const keys = (value.key ?? "")
              .split("+")
              .map((item) => item.trim().toLowerCase())
              .filter(Boolean);
            if (value.holdDurationMs != null && value.holdDurationMs > 0 && keys.length === 1) {
              const key = keys[0] ?? "";
              await this.#xdotool(["keydown", key]);
              await wait(Math.min(value.holdDurationMs, 5_000));
              await this.#xdotool(["keyup", key]);
            } else if (keys.length > 1) {
              await this.#call("hotkey", { keys, scope: "desktop", session: this.#session });
            } else {
              await this.#call("press_key", {
                key: keys[0] ?? (value.key ?? "").toLowerCase(),
                scope: "desktop",
                session: this.#session,
              });
            }
            break;
          }
          case "wait":
            await wait(Math.min(Math.max(0, value.durationMs ?? 0), 10_000));
            break;
          case "screenshot":
            screenshot = await this.#screenshot();
            break;
          case "cursorPosition":
            cursorPosition = await this.#cursorPosition();
            break;
          default:
            throw new Error(`Unsupported computer action: ${action.case ?? "unset"}`);
        }
        actionCount += 1;
        log.push(action.case ?? "unset");
      }
      return {
        result: {
          case: "success",
          value: {
            actionCount,
            durationMs: Date.now() - startedAt,
            ...(screenshot == null ? {} : { screenshot }),
            ...(cursorPosition == null ? {} : { cursorPosition }),
            ...(log.length === 0 ? {} : { log: log.join(",") }),
          },
        },
      };
    } catch (error) {
      return {
        result: {
          case: "error",
          value: {
            error: errorText(error),
            actionCount: 0,
            durationMs: Date.now() - startedAt,
          },
        },
      };
    } finally {
      release();
    }
  }

  async #call(tool: string, input: BoxDriverCall, extra: readonly string[] = []): Promise<string> {
    const result = await this.#runner(
      this.#executable,
      ["call", tool, JSON.stringify(input), "--socket", this.#socket, ...extra],
      { env: this.#environment, timeoutMs: CALL_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Cua Driver ${tool} failed.`);
    }
    return result.stdout.trim();
  }

  async #xdotool(args: readonly string[]): Promise<void> {
    const result = await this.#runner("xdotool", args, {
      env: { ...this.#environment, DISPLAY: this.#environment.DISPLAY ?? ":1" },
      timeoutMs: XDOTOOL_TIMEOUT_MS,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "xdotool failed.");
  }

  async #cursorPosition(): Promise<GrokBotBoxCoordinate> {
    const output = await this.#call("get_cursor_position", { session: this.#session });
    const parsed = JSON.parse(output);
    if (!isDynamicRecord(parsed)) throw new Error("Cua Driver returned a non-object response.");
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Cua Driver returned an invalid cursor position.");
    return { x: Math.round(x), y: Math.round(y) };
  }

  async #screenshot(): Promise<string> {
    const temporary = await mkdtemp(path.join(this.#temporaryDirectory, "botai-box-cua-"));
    const outputPath = path.join(temporary, "screen.png");
    try {
      await this.#call("get_desktop_state", { session: this.#session }, ["--screenshot-out-file", outputPath]);
      return (await readFile(outputPath)).toString("base64");
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function defaultRunner(
  executable: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<GrokBotBoxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? CALL_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\nCua Driver timed out.`.trim() : stderr,
      });
    });
  });
}

function mouseButton(value: number | undefined): "left" | "right" | "middle" {
  if (value === 2) return "right";
  if (value === 3) return "middle";
  return "left";
}

function xdotoolButton(value: number | undefined): "1" | "2" | "3" | "8" | "9" {
  if (value === 2) return "3";
  if (value === 3) return "2";
  if (value === 4) return "8";
  if (value === 5) return "9";
  return "1";
}

function scrollDirection(value: number | undefined): "up" | "down" | "left" | "right" {
  if (value === 1) return "up";
  if (value === 3) return "left";
  if (value === 4) return "right";
  return "down";
}

function parseModifiers(value: string | undefined): string[] {
  return value == null
    ? []
    : value
        .split(/[+,]/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
