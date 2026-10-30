import type { CreateGrokBotAgentInput } from "@openbot/contracts/ipc";
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import {
  GrokBotAccountFailed,
  GrokBotAccountStore,
  publicGrokBotStatus,
  type SecretCipher,
  startGrokBotSignIn,
} from "../backend/grok-bot/grok-bot-account";
import { createGrokBotAgent, listGrokBotAgents } from "../backend/grok-bot/grok-bot-gateway";
import { readGrokBotUsageSummary } from "../backend/grok-bot/grok-bot-usage";
import { type RendererIpcWindow, sendToRenderer } from "./renderer-ipc";

const GROK_BOT_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const OFFICIAL_API = "https://api2.cursor.sh";

export interface GrokBotAccountServiceOptions {
  path: string;
  cipher: SecretCipher;
  getMainWindow: () => RendererIpcWindow | null;
}

/** One Grok Bot sign-in on this computer. The file and cipher come from the caller. */
export class GrokBotAccountService {
  readonly #path: string;
  readonly #cipher: SecretCipher;
  readonly #getMainWindow: () => RendererIpcWindow | null;
  readonly #store: GrokBotAccountStore;
  #abort: AbortController | null = null;

  constructor(options: GrokBotAccountServiceOptions) {
    this.#path = options.path;
    this.#cipher = options.cipher;
    this.#getMainWindow = options.getMainWindow;
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
    this.#abort?.abort();
    this.#abort = null;
    yield* this.#store.clear();
    sendToRenderer(this.#getMainWindow(), IPC_ENDPOINTS.grokBot.account, { phase: "signed-out" });
    return { signedIn: false };
  });

  readonly list = Effect.fn("GrokBotAccountService.list")(function* (this: GrokBotAccountService) {
    return yield* listGrokBotAgents(this.#store, callOptions());
  });

  readonly usage = Effect.fn("GrokBotAccountService.usage")(function* (this: GrokBotAccountService) {
    return yield* readGrokBotUsageSummary(this.#store);
  });

  readonly create = Effect.fn("GrokBotAccountService.create")(function* (
    this: GrokBotAccountService,
    input: CreateGrokBotAgentInput,
  ) {
    return yield* createGrokBotAgent(this.#store, input, callOptions());
  });

  dispose(): void {
    this.#abort?.abort();
    this.#abort = null;
  }
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
