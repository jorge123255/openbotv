import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type { HermesGatewayFailure } from "../hermes-gateway-protocol";
import type { HermesGatewaySetupService } from "../hermes-gateway-setup-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import {
  parseProbeHermesGateway,
  parseSelectHermesGatewayProfile,
  parseSignInHermesGateway,
} from "./hermes-gateway-inputs";
import { stringPayload } from "./validation";

const FAILURE_TEXT = {
  "invalid-address": "error.hermesGateway.address",
  "tls-required": "error.hermesGateway.unsupported",
  "unsupported-auth": "error.hermesGateway.unsupported",
  cancelled: "error.hermesGateway.cancelled",
  consent: "error.hermesGateway.rememberCancelled",
  storage: "error.hermesGateway.storage",
  profile: "error.hermesGateway.profile",
  busy: "error.hermesGateway.busy",
  limit: "error.hermesGateway.limit",
} as const;

/** Fixed localized messages only. Remote errors, tokens, callback URLs and causes never cross IPC. */
async function runGateway<A>(operation: Effect.Effect<A, HermesGatewayFailure>): Promise<A> {
  let result: Result.Result<A, HermesGatewayFailure>;
  try {
    result = await Effect.runPromise(Effect.result(operation));
  } catch {
    throw new Error(sourceText("error.hermesGateway.failed"));
  }
  if (Result.isFailure(result)) {
    const code = result.failure.code;
    const key = Object.entries(FAILURE_TEXT).find(([candidate]) => candidate === code)?.[1];
    throw new Error(sourceText(key ?? "error.hermesGateway.failed"));
  }
  return result.success;
}
export interface HermesGatewayIpcDependencies {
  hermesGateways: HermesGatewaySetupService;
}
export function hermesGatewayIpcHandlers({
  hermesGateways,
}: HermesGatewayIpcDependencies): Pick<IpcGroupHandlers, "hermesGateways"> {
  return {
    hermesGateways: {
      list: handler(() => hermesGateways.list()),
      probe: payloadHandler(parseProbeHermesGateway, ({ url, id }) => runGateway(hermesGateways.probe(url, id))),
      signIn: payloadHandler(parseSignInHermesGateway, ({ id, providerId }) =>
        runGateway(hermesGateways.signIn(id, providerId)),
      ),
      selectProfile: payloadHandler(parseSelectHermesGatewayProfile, ({ id, profileId, remember }) =>
        runGateway(hermesGateways.selectProfile(id, profileId, remember)),
      ),
      disconnect: payloadHandler(stringPayload("Gateway ID", 36), (id) => runGateway(hermesGateways.disconnect(id))),
      forget: payloadHandler(stringPayload("Gateway ID", 36), (id) => runGateway(hermesGateways.forget(id))),
    },
  };
}
