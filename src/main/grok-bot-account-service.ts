import type { CreateGrokBotAgentInput, GrokBotComputerSummary } from "@openbot/contracts/ipc";
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import {
  GrokBotAccountFailed,
  GrokBotAccountStore,
  publicGrokBotStatus,
  type SecretCipher,
  startGrokBotSignIn,
} from "../backend/grok-bot/grok-bot-account";
import type { GrokBotComputerStatus } from "../backend/grok-bot/grok-bot-computer";
import {
  createGrokBotAgent,
  ensureGrokBotComputer,
  handBackGrokBotComputer,
  listGrokBotAgents,
  readGrokBotComputer,
} from "../backend/grok-bot/grok-bot-gateway";
import { readGrokBotUsageSummary } from "../backend/grok-bot/grok-bot-usage";
import { readGrokBotUsageDiagnostic } from "../backend/grok-bot/grok-bot-usage-diagnostic";
import { type GrokBotImportStore, importGrokBotAgents } from "./grok-bot-agent-import";
import { GrokBotComputerWindow } from "./grok-bot-computer-window";
import { type RendererIpcWindow, sendToRenderer } from "./renderer-ipc";

const GROK_BOT_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const OFFICIAL_API = "https://api2.cursor.sh";
const diagnosticLogger = createOpenBotLogger("grok-bot-cached-usage-diagnostic");

export interface GrokBotAccountServiceOptions {
  path: string;
  cipher: SecretCipher;
  getMainWindow: () => RendererIpcWindow | null;
  /** The local roster an import writes to. Absent, import fails; Grok Bot is never written. */
  agentStore?: GrokBotImportStore;
}

/** One Grok Bot sign-in on this computer. The file and cipher come from the caller. */
export class GrokBotAccountService {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  readonly #getMainWindow: () => RendererIpcWindow | null;
  readonly #store: GrokBotAccountStore;
  readonly #agentStore: GrokBotImportStore | undefined;
  #abort: AbortController | null = null;
  #computer = new GrokBotComputerWindow();
  #diagnosticAbort: AbortController | null = null;

  constructor(options: GrokBotAccountServiceOptions) {
    this.#path = options.path;
    this.#cipher = options.cipher;
    this.#getMainWindow = options.getMainWindow;
    this.#agentStore = options.agentStore;
    this.#store = new GrokBotAccountStore(options.path, options.cipher);
  }

  /** The sand account the Grok Bot provider reads. The renderer does not receive this store. */
  accountStore(): GrokBotAccountStore {
    return this.#store;
  }

  readonly status = Effect.fn("GrokBotAccountService.status")(function* (this: GrokBotAccountService) {
    return publicGrokBotStatus(yield* this.#store.load());
  });

  readonly start = Effect.fn("GrokBotAccountService.start")(function* (this: GrokBotAccountService) {
    this.#diagnosticAbort?.abort();
    this.#store.forgetCachedGateway();
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;
    const apiBaseUrl = sandApiBase();
    const started = yield* startGrokBotSignIn({
      timeoutMs: GROK_BOT_SIGN_IN_TIMEOUT_MS,
      authFile: this.#path,
      cipher: this.#cipher,
      signal: controller.signal,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    });
    void Effect.runPromise(started.done).then(
      () => {
        sendToRenderer(this.#getMainWindow(), IPC_ENDPOINTS.grokBot.account, { phase: "signed-in" });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        sendToRenderer(this.#getMainWindow(), IPC_ENDPOINTS.grokBot.account, {
          phase: "failed",
          message: failureMessage(error),
        });
      },
    );
    return { verificationUrl: started.verificationUrl };
  });

  readonly cancel = Effect.fn("GrokBotAccountService.cancel")(function* (this: GrokBotAccountService) {
    this.#abort?.abort();
    this.#abort = null;
    yield* Effect.void;
  });

  readonly signOut = Effect.fn("GrokBotAccountService.signOut")(function* (this: GrokBotAccountService) {
    this.#diagnosticAbort?.abort();
    this.#abort?.abort();
    this.#abort = null;
    yield* this.#store.clear();
    sendToRenderer(this.#getMainWindow(), IPC_ENDPOINTS.grokBot.account, { phase: "signed-out" });
    return { signedIn: false };
  });

  readonly list = Effect.fn("GrokBotAccountService.list")(function* (this: GrokBotAccountService) {
    return yield* listGrokBotAgents(this.#store, callOptions());
  });

  /** Lists Grok Bot agents and mirrors them locally. Read-only toward Grok Bot: no create call. */
  readonly importAgents = Effect.fn("GrokBotAccountService.importAgents")(function* (this: GrokBotAccountService) {
    const store = this.#agentStore;
    if (!store) return yield* Effect.die(new Error("Grok Bot import has no local agent store."));
    const remote = yield* listGrokBotAgents(this.#store, callOptions());
    return yield* importGrokBotAgents(remote, store);
  });

  readonly usage = Effect.fn("GrokBotAccountService.usage")(function* (this: GrokBotAccountService) {
    return yield* readGrokBotUsageSummary(this.#store);
  });

  /** Native opt-in action only. This is deliberately absent from renderer IPC and the Team API. */
  readonly diagnoseCachedUsage = Effect.fn("GrokBotAccountService.diagnoseCachedUsage")(function* (
    this: GrokBotAccountService,
    optedIn: boolean,
  ) {
    if (!optedIn || this.#diagnosticAbort !== null) return;
    const controller = new AbortController();
    this.#diagnosticAbort = controller;
    yield* readGrokBotUsageDiagnostic({
      optedIn,
      cachedGateway: () => this.#store.cachedGateway(),
      signal: controller.signal,
    }).pipe(
      Effect.tap((report) =>
        Effect.sync(() => diagnosticLogger.info("Cached Grok Bot usage capability check.", report)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.#diagnosticAbort = null;
        }),
      ),
    );
  });

  readonly create = Effect.fn("GrokBotAccountService.create")(function* (
    this: GrokBotAccountService,
    input: CreateGrokBotAgentInput,
  ) {
    return yield* createGrokBotAgent(this.#store, input, callOptions());
  });

  /** The sand computer (BotAI forever box). The screen URL stays in main. */
  readonly computerStatus = Effect.fn("GrokBotAccountService.computerStatus")(function* (this: GrokBotAccountService) {
    return computerSummary(yield* readGrokBotComputer(this.#store, callOptions()), this.#computer.isOpen());
  });

  /** BotAI "Open computer": ensure the box, then show its screen in the computer window. */
  readonly openComputer = Effect.fn("GrokBotAccountService.openComputer")(function* (this: GrokBotAccountService) {
    const status = yield* ensureGrokBotComputer(this.#store, callOptions());
    if (status.vncUrl) this.#computer.open(status.vncUrl, status.networkToken, "Grok Bot computer");
    return computerSummary(status, this.#computer.isOpen());
  });

  /** BotAI "I'm done, continue": give the computer back to the agent that asked for a takeover. */
  readonly handBackComputer = Effect.fn("GrokBotAccountService.handBackComputer")(function* (
    this: GrokBotAccountService,
  ) {
    const status = yield* readGrokBotComputer(this.#store, callOptions());
    if (status.handoffAgentId) yield* handBackGrokBotComputer(this.#store, status.handoffAgentId, callOptions());
    return computerSummary(yield* readGrokBotComputer(this.#store, callOptions()), this.#computer.isOpen());
  });

  dispose(): void {
    this.#diagnosticAbort?.abort();
    this.#store.forgetCachedGateway();
    this.#computer.close();
    this.#abort?.abort();
    this.#abort = null;
  }
}

function computerSummary(status: GrokBotComputerStatus, windowOpen: boolean): GrokBotComputerSummary {
  return {
    phase: status.phase,
    screenAvailable: status.vncUrl !== null,
    windowOpen,
    pullPercent: status.pullPercent,
    imageUpdateAvailable: status.imageUpdateAvailable,
    needsYou: status.handoffAgentId !== null,
    handoffReason: status.handoffReason,
  };
}

function callOptions(): { allowLoopback: false; apiBaseUrl?: string } {
  const apiBaseUrl = sandApiBase();
  return { allowLoopback: false, ...(apiBaseUrl ? { apiBaseUrl } : {}) };
}

function sandApiBase(): string | undefined {
  const raw = process.env.CURSOR_API_BASE_URL;
  if (!raw) return undefined;
  const base = raw.replace(/\/+$/u, "");
  return base === OFFICIAL_API ? base : undefined;
}

function failureMessage(error: unknown): string {
  const cause = error instanceof GrokBotAccountFailed ? error.cause : error;
  return cause instanceof Error ? cause.message : sourceText("error.provider.grokBotSignInEnded");
}
