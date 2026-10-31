import type {
  ProbeHermesGatewayInput,
  SelectHermesGatewayProfileInput,
  SignInHermesGatewayInput,
} from "@openbot/contracts/ipc";
import { isObject, requireString } from "./validation";

function fields(value: unknown, keys: readonly string[]) {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Invalid Hermes gateway request.");
  return value;
}
export function parseProbeHermesGateway(value: unknown): ProbeHermesGatewayInput {
  const input = fields(value, ["url", "id"]);
  return {
    url: requireString(input.url, "Gateway URL", 2_048),
    ...(input.id === undefined ? {} : { id: requireString(input.id, "Gateway ID", 36) }),
  };
}
export function parseSignInHermesGateway(value: unknown): SignInHermesGatewayInput {
  const input = fields(value, ["id", "providerId"]);
  return {
    id: requireString(input.id, "Gateway ID", 36),
    providerId: requireString(input.providerId, "Provider ID", 256),
  };
}
export function parseSelectHermesGatewayProfile(value: unknown): SelectHermesGatewayProfileInput {
  const input = fields(value, ["id", "profileId", "remember"]);
  if (typeof input.remember !== "boolean") throw new Error("Invalid Hermes gateway remember choice.");
  return {
    id: requireString(input.id, "Gateway ID", 36),
    profileId: requireString(input.profileId, "Profile ID", 256),
    remember: input.remember,
  };
}
