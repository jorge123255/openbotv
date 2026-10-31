import { runCauseEffect } from "../../backend/effect-boundary";
import type { OllamaQuotaService } from "../ollama-quota-service";
import { parseAgentId } from "./agent-inputs";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { requireString } from "./validation";

export interface OllamaQuotaIpcDependencies {
  ollamaQuota: OllamaQuotaService;
}

export function ollamaQuotaIpcHandlers({
  ollamaQuota,
}: OllamaQuotaIpcDependencies): Pick<IpcGroupHandlers, "ollamaQuota"> {
  return {
    ollamaQuota: {
      read: payloadHandler(parseAgentId, (id) => runCauseEffect(ollamaQuota.read(id))),
      dismiss: payloadHandler(
        (value) => requireString(value, "warningId", 128),
        (id) => ollamaQuota.dismiss(id),
      ),
    },
  };
}
