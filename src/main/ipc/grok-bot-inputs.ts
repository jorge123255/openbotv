import type { CreateGrokBotAgentInput } from "@openbot/contracts/ipc";
import { isObject, requireString } from "./validation";

export function parseCreateGrokBotAgentInput(value: unknown): CreateGrokBotAgentInput {
  if (!isObject(value)) throw new Error("Invalid Grok Bot agent.");
  return {
    name: requireString(value.name, "name", 80),
    description: typeof value.description === "string" ? value.description.slice(0, 2000) : "",
  };
}
