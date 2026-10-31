import { decodeHostToolAnswer, type HostToolAnswer } from "@openbot/contracts/ipc";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface HostToolIpcDependencies {
  answer(input: HostToolAnswer): void;
}

function requireHostToolAnswer(value: unknown): HostToolAnswer {
  const decoded = decodeHostToolAnswer(value);
  if (decoded === null) throw new Error("Invalid host tool answer.");
  return decoded;
}

/**
 * The desktop answer for one host-tool ask. The sender check stays in the group binder.
 * This handler does not read a gateway token.
 */
export function hostToolIpcHandlers(deps: HostToolIpcDependencies): Pick<IpcGroupHandlers, "hostTools"> {
  return {
    hostTools: {
      answer: payloadHandler(requireHostToolAnswer, (input) => {
        deps.answer(input);
      }),
    },
  };
}
