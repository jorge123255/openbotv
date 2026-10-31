import { OLLAMA_QUOTA_FRESH_MS, type OllamaQuotaSnapshot } from "@openbot/contracts/ipc";
import { Button, ConfirmDialog } from "@openbot/ui";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useText } from "../../text";
import { ComposerNotice } from "./ComposerNotice";

export interface QuotaRecommendation {
  key: string;
  model: string;
  provider: string;
  account: string;
  /** Called only after the person confirms. The caller revalidates binding and availability. */
  onConfirm(isCurrent: () => boolean): Promise<boolean>;
}

/** Passive account information. It never blocks sends, resumes a task, or changes a model itself. */
export function QuotaNotice(props: {
  reading: OllamaQuotaSnapshot | null;
  connectionName: string;
  now: number;
  recommendation?: QuotaRecommendation | undefined;
  switchQueued?: boolean;
  onDismiss: (ids: string[]) => void;
}) {
  const { t, format } = useText();
  const [confirming, setConfirming] = createSignal<QuotaRecommendation | null>(null);
  const [failed, setFailed] = createSignal(false);
  let confirmationGeneration = 0;
  onSettled(() => () => {
    confirmationGeneration++;
  });
  const fresh = () =>
    props.reading?.state === "fresh" &&
    props.reading.checkedAt !== null &&
    props.now >= props.reading.checkedAt &&
    props.now - props.reading.checkedAt < OLLAMA_QUOTA_FRESH_MS;
  const warnings = () =>
    fresh()
      ? (props.reading?.windows ?? []).filter(
          (window) =>
            window.warningId &&
            window.usedPercent !== null &&
            window.usedPercent >= 90 &&
            window.resetsAt !== null &&
            window.resetsAt > props.now,
        )
      : [];
  const windowLabels = {
    included: "composer.quota.window.included",
    session: "composer.quota.window.session",
    weekly: "composer.quota.window.weekly",
  } as const;
  const date = (value: number) =>
    format.date(new Date(value), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const purchased = (details: boolean) => {
    const balance = props.reading?.purchasedBalanceUsd;
    return balance === null || balance === undefined
      ? t("composer.quota.purchasedUnknown")
      : t(details ? "composer.quota.purchased" : "composer.quota.creditsBalance", {
          amount: format.currencyUsd(balance),
        });
  };
  const confirmationScope = createMemo(() =>
    [
      props.reading?.poolId,
      props.recommendation?.key,
      warnings()
        .map((window) => window.warningId)
        .join(","),
    ].join("|"),
  );
  createEffect(confirmationScope, () => {
    confirmationGeneration++;
    setConfirming(null);
    setFailed(false);
  });
  return (
    <section class="quota-notice" aria-label={t("composer.quota.label")}>
      <details>
        <summary>{t("composer.quota.connection", { name: props.connectionName })}</summary>
        <p>{t("composer.quota.accountBinding")}</p>
        <Show when={props.reading?.checkedAt}>
          {(checked) => <p>{t("composer.quota.checked", { date: date(checked()) })}</p>}
        </Show>
        <Show
          when={fresh()}
          fallback={
            <p>{t(props.reading?.state === "stale" ? "composer.quota.stale" : "composer.quota.unavailable")}</p>
          }
        >
          <ul>
            <For each={props.reading?.windows}>
              {(window) => (
                <li>
                  {t(windowLabels[window.id])}:{" "}
                  {window.usedPercent === null || window.resetsAt === null || window.resetsAt <= props.now
                    ? t("composer.quota.unknown")
                    : t("composer.quota.used", {
                        percent: format.number(window.usedPercent, { maximumFractionDigits: 1 }),
                      })}
                  <Show when={window.resetsAt !== null && window.resetsAt > props.now ? window.resetsAt : undefined}>
                    {(reset) => <> · {t("composer.quota.reset", { date: date(reset()) })}</>}
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <p>{purchased(true)}</p>
        </Show>
      </details>
      <Show when={warnings().length > 0}>
        <ComposerNotice
          dismissLabel={t("composer.quota.dismiss")}
          title={t("composer.quota.warningTitle")}
          body={t("composer.quota.warningBody", {
            name: props.connectionName,
            windows: warnings()
              .map((window) =>
                t("composer.quota.warningWindow", {
                  window: t(windowLabels[window.id]),
                  percent:
                    window.usedPercent === null
                      ? t("composer.quota.unknown")
                      : format.number(window.usedPercent, { maximumFractionDigits: 1 }),
                  reset: window.resetsAt === null ? t("composer.quota.unknown") : date(window.resetsAt),
                }),
              )
              .join("; "),
            credits: purchased(false),
          })}
          onDismiss={() =>
            props.onDismiss(warnings().flatMap((window) => (window.warningId ? [window.warningId] : [])))
          }
          action={
            <Show when={props.recommendation}>
              {(recommendation) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFailed(false);
                    setConfirming(recommendation());
                  }}
                >
                  {t("composer.quota.reviewSwitch")}
                </Button>
              )}
            </Show>
          }
        />
        <Show when={!props.recommendation}>
          <p class="quota-notice-hint">
            {t(props.switchQueued ? "composer.quota.switchQueued" : "composer.quota.noRecommendation")}
          </p>
        </Show>
      </Show>
      <ConfirmDialog
        open={confirming() !== null}
        tone="default"
        initialFocus="cancel"
        title={t("composer.quota.confirmTitle")}
        description={t("composer.quota.confirmTarget", {
          model: confirming()?.model ?? "",
          provider: confirming()?.provider ?? "",
          account: confirming()?.account ?? "",
        })}
        confirmLabel={t("composer.quota.confirm")}
        onCancel={() => {
          confirmationGeneration++;
          setConfirming(null);
        }}
        error={failed() ? t("composer.quota.switchChanged") : undefined}
        onConfirm={async () => {
          const recommendation = confirming();
          if (!recommendation) return;
          const generation = confirmationGeneration;
          const isCurrent = () =>
            generation === confirmationGeneration &&
            confirming()?.key === recommendation.key &&
            props.recommendation?.key === recommendation.key &&
            warnings().length > 0;
          if (await recommendation.onConfirm(isCurrent)) setConfirming(null);
          else setFailed(true);
        }}
      >
        <p>{t("composer.quota.confirmCost")}</p>
        <p>{t("composer.quota.confirmContext")}</p>
        <p>{t("composer.quota.confirmHandover")}</p>
      </ConfirmDialog>
    </section>
  );
}
