import { runCauseEffect } from "../../backend/effect-boundary";
import type { GrokBotAccountService } from "../grok-bot-account-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { parseCreateGrokBotAgentInput } from "./grok-bot-inputs";

export interface GrokBotIpcDependencies {
  grokBotAccount: GrokBotAccountService;
}

export function grokBotIpcHandlers({ grokBotAccount }: GrokBotIpcDependencies): Pick<IpcGroupHandlers, "grokBot"> {
  return {
    grokBot: {
      getStatus: handler(() => runCauseEffect(grokBotAccount.status())),
      startSignIn: handler(() => runCauseEffect(grokBotAccount.start())),
      cancelSignIn: handler(() => runCauseEffect(grokBotAccount.cancel())),
      signOut: handler(() => runCauseEffect(grokBotAccount.signOut())),
      listAgents: handler(() => runCauseEffect(grokBotAccount.list())),
      getUsage: handler(() => runCauseEffect(grokBotAccount.usage())),
      importAgents: handler(() => runCauseEffect(grokBotAccount.importAgents())),
      createAgent: payloadHandler(parseCreateGrokBotAgentInput, (input) =>
        runCauseEffect(grokBotAccount.create(input)),
      ),
    },
  };
}
