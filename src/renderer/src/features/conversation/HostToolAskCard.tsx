import type { HostToolDecision } from "@openbot/contracts/ipc";
import { HostToolApprovalCard } from "@openbot/ui/features/conversation/HostToolApprovalCard";
import { createEffect, createSignal, Show } from "solid-js";

/** The host-tool ask for this agent, from the desktop event. */
export function HostToolAskCard(props: { agentId: string | undefined }) {
  const [requestId, setRequestId] = createSignal<string | null>(null);
  const [actionLabel, setActionLabel] = createSignal("");
  const [detail, setDetail] = createSignal("");
  const [pending, setPending] = createSignal(false);

  createEffect(
    () => props.agentId,
    (agentId) => {
      const api = window.openbot?.hostTools;
      if (!agentId || !api) return;
      return api.onAsk((ask) => {
        if (ask.agentId !== agentId) return;
        setRequestId(ask.requestId);
        setActionLabel(ask.action);
        setDetail(ask.detail);
        setPending(false);
      });
    },
  );

  const answer = (decision: HostToolDecision) => {
    const id = requestId();
    const api = window.openbot?.hostTools;
    if (!id || !api || pending()) return;
    setPending(true);
    void api.answer({ requestId: id, decision }).then(() => {
      setRequestId(null);
      setPending(false);
    });
  };

  return (
    <Show when={requestId()}>
      <HostToolApprovalCard
        actionLabel={actionLabel()}
        detail={detail()}
        pending={pending()}
        onAllowOnce={() => answer("allow-once")}
        onAlways={() => answer("always")}
        onNever={() => answer("never")}
      />
    </Show>
  );
}
