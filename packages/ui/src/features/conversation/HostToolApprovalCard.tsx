import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";

export interface HostToolApprovalCardProps {
  actionLabel: string;
  detail: string;
  pending: boolean;
  onAllowOnce: () => void;
  onAlways: () => void;
  onNever: () => void;
}

/** Three choices for one host tool. It does not grant command approval. */
export function HostToolApprovalCard(props: HostToolApprovalCardProps) {
  const { t } = useText();
  return (
    <section
      class="approval-card conversation-interaction-card"
      aria-label={t("prompt.hostTool.label")}
      aria-busy={props.pending ? "true" : undefined}
    >
      <header class="approval-card-header conversation-interaction-header">
        <strong>{props.actionLabel}</strong>
      </header>
      <p class="approval-reason">{props.detail}</p>
      <footer class="approval-card-footer">
        <Button type="button" class="approval-button" disabled={props.pending} onClick={() => props.onAllowOnce()}>
          {t("prompt.hostTool.allowOnce")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          class="approval-button"
          disabled={props.pending}
          onClick={() => props.onAlways()}
        >
          {t("prompt.hostTool.always")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          class="approval-button"
          disabled={props.pending}
          onClick={() => props.onNever()}
        >
          {t("prompt.hostTool.never")}
        </Button>
      </footer>
    </section>
  );
}
