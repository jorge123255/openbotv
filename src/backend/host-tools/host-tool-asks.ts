import type { HostToolAnswer, HostToolDecision } from "@openbot/contracts/ipc";

const pending = new Map<string, (decision: HostToolDecision) => void>();

/** Waits until the desktop answers this request id. */
export function waitForHostToolAnswer(requestId: string): Promise<HostToolDecision> {
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
  });
}

/** Resolves the pending ask for this request id. An unknown id does nothing. */
export function answerHostTool(answer: HostToolAnswer): void {
  const resolve = pending.get(answer.requestId);
  if (resolve === undefined) return;
  pending.delete(answer.requestId);
  resolve(answer.decision);
}

/** Drops a pending ask when the turn ends before the card is answered. */
export function cancelHostToolAnswer(requestId: string): void {
  pending.delete(requestId);
}
