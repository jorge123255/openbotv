import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { KeyOnlyProviderId } from "@openbot/contracts/agent-providers";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Deferred, Effect } from "effect";
import { RequestTimeoutError } from "./agent-client";
import type { SpawnTarget } from "./process-confinement";
import { type ProviderClientOperationError, providerFailure } from "./provider-client-effects";
import { registerProviderProcess } from "./provider-processes";
import { createDiagnosticStream } from "./stderr-diagnostics";
import { stopProviderChild } from "./windows-process-tree";

const PI_RECORD_LIMIT_BYTES = 256 * 1024 * 1024;

/** Owns one Pi RPC process and its correlated requests. Session policy belongs to the client. */
export class PiRpc extends EventEmitter<{ record: [DynamicRecord]; diagnostic: [string]; exit: [Error] }> {
  readonly #pending = new Map<string, (result: Effect.Effect<DynamicRecord, ProviderClientOperationError>) => void>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #stopping = false;
  /** The stop already running, so a second caller waits for the same end. */
  #stopGate: Deferred.Deferred<void> | null = null;
  constructor(
    private readonly redact: (text: string) => string,
    private readonly provider: "pi" | KeyOnlyProviderId = "pi",
  ) {
    super();
  }

  start(target: SpawnTarget, cwd: string, env: NodeJS.ProcessEnv): void {
    if (this.#child) throw new Error("Pi process is already running.");
    const child = spawn(target.command, target.args, {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    this.#child = child;
    registerProviderProcess(child, this.provider);
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    const diagnostics = createDiagnosticStream({ redact: this.redact, emit: (line) => this.emit("diagnostic", line) });
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      const safe = new Error(this.redact(error.message));
      for (const resume of this.#pending.values()) resume(Effect.fail(providerFailure(safe)));
      this.#pending.clear();
      if (!this.#stopping) this.emit("exit", safe);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => diagnostics.push(chunk));
    child.stdin.on("error", fail);
    child.once("error", fail);
    child.once("close", (code, signal) => {
      diagnostics.flush();
      fail(new Error(`Pi process closed (${signal ?? code ?? "unknown"}).`));
      if (this.#child === child) this.#child = null;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      try {
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (Buffer.byteLength(line) > PI_RECORD_LIMIT_BYTES) throw new Error("Pi RPC record is too large.");
          if (line.trim()) this.#record(JSON.parse(line));
          newline = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered) > PI_RECORD_LIMIT_BYTES) throw new Error("Pi RPC record is too large.");
      } catch {
        buffered = "";
        fail(new Error("Pi returned an invalid RPC record."));
        child.kill("SIGTERM");
      }
    });
  }

  #record(value: unknown): void {
    if (!isDynamicRecord(value) || typeof value.type !== "string") throw new Error("Invalid Pi RPC record.");
    if (value.type !== "response") {
      this.emit("record", value);
      return;
    }
    if (typeof value.id !== "string") return;
    const resume = this.#pending.get(value.id);
    if (!resume) return;
    this.#pending.delete(value.id);
    if (value.success === true) resume(Effect.succeed(isDynamicRecord(value.data) ? value.data : {}));
    else
      resume(
        Effect.fail(
          providerFailure(new Error(this.redact(typeof value.error === "string" ? value.error : "Pi request failed."))),
        ),
      );
  }

  readonly request = Effect.fn("PiRpc.request")(function* (this: PiRpc, command: DynamicRecord, timeoutMs = 30_000) {
    const id = randomUUID();
    return yield* Effect.callback<DynamicRecord, ProviderClientOperationError>((resume) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resume(Effect.fail(providerFailure(new RequestTimeoutError("Pi", String(command.type)))));
      }, timeoutMs);
      this.#pending.set(id, (result) => {
        clearTimeout(timer);
        resume(result);
      });
      try {
        this.send({ ...command, id });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resume(Effect.fail(providerFailure(cause)));
      }
      return Effect.sync(() => {
        clearTimeout(timer);
        this.#pending.delete(id);
      });
    });
  });

  send(record: DynamicRecord): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("Pi is not running.");
    child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  readonly stop = Effect.fn("PiRpc.stop")(function* (this: PiRpc) {
    if (this.#stopGate) return yield* Deferred.await(this.#stopGate);
    const gate = Deferred.makeUnsafe<void>();
    this.#stopGate = gate;
    this.#stopping = true;
    const child = this.#child;
    this.#child = null;
    yield* (child ? stopProviderChild(child).pipe(Effect.orDie) : Effect.void).pipe(
      Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(gate, Effect.void))),
    );
  }, Effect.uninterruptible);
}
