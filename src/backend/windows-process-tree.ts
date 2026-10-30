import { type ChildProcess, execFile } from "node:child_process";
import { Effect, Fiber, Schema } from "effect";

/**
 * Stops a process and every process it started, and waits for it to exit. Windows has no process
 * group: a `.cmd` command runs under `cmd.exe`, and a kill of the wrapper leaves the real program
 * running. `taskkill /T` stops the whole tree while the wrapper still holds it.
 */
class ProcessTreeFailed extends Schema.TaggedError<ProcessTreeFailed>()("ProcessTreeFailed", {
  cause: Schema.Defect(),
}) {}

export const stopWindowsProcessTree = Effect.fn("WindowsProcessTree.stop")(function* (child: ChildProcess) {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = yield* Effect.forkChild(
    Effect.callback<void>((resume) => {
      const onExit = () => {
        child.off("exit", onExit);
        resume(Effect.void);
      };
      child.once("exit", onExit);
      return Effect.sync(() => child.off("exit", onExit));
    }),
    { startImmediately: true },
  );
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve) =>
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()),
      ),
    catch: (cause) => new ProcessTreeFailed({ cause }),
  });
  yield* Effect.try({
    try: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
    catch: (cause) => new ProcessTreeFailed({ cause }),
  });
  yield* Fiber.join(exited);
}, Effect.uninterruptible);

/** How long a provider may take to exit after SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 1_000;

/** How long quit waits after SIGKILL. A process that does not report its exit must not hold shutdown. */
const EXIT_AFTER_KILL_MS = 1_000;

function signalProviderChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The child is not a process-group leader. The direct signal below still applies.
    }
  }
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch {
    // The process has already ended.
  }
}

function destroyProviderPipes(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Ends one provider child and returns. On Windows it stops the whole tree. Elsewhere it sends
 * SIGTERM, then SIGKILL, and returns even when the process never reports that it exited. Quit can
 * then finish inside the agent-service step.
 */
export const stopProviderChild = Effect.fn("ProcessTree.stopChild")(function* (child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") return yield* stopWindowsProcessTree(child);
  yield* Effect.callback<void>((resume) => {
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      child.off("exit", finish);
      resume(Effect.void);
    };
    child.once("exit", finish);
    try {
      child.stdin?.end();
    } catch {
      // The pipe is already closed.
    }
    signalProviderChild(child, "SIGTERM");
    killTimer = setTimeout(() => {
      signalProviderChild(child, "SIGKILL");
      destroyProviderPipes(child);
    }, TERM_GRACE_MS);
    giveUp = setTimeout(finish, TERM_GRACE_MS + EXIT_AFTER_KILL_MS);
    return Effect.sync(() => {
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      child.off("exit", finish);
    });
  });
});

/**
 * Ends a provider process and waits for it to exit, or for the kill grace. On Windows it stops the
 * whole tree. Elsewhere it sends SIGTERM, and SIGKILL when the process is still running after 1 second.
 */
export const endProcessTree = Effect.fn("ProcessTree.end")(function* (child: ChildProcess) {
  yield* stopProviderChild(child);
});

/**
 * Stops a process that may run under `cmd.exe`, such as a sign-in through a `.cmd` launcher, and
 * does not wait for it. Elsewhere SIGTERM goes to the process itself.
 */
export const stopProcessTree = Effect.fn("ProcessTree.stop")(function* (child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") yield* stopWindowsProcessTree(child);
  else yield* Effect.try({ try: () => child.kill("SIGTERM"), catch: (cause) => new ProcessTreeFailed({ cause }) });
});
