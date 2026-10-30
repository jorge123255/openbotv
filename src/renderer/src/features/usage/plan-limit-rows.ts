import {
  type AccountUsageProviderRow,
  accountUsageProviderRows,
  grokBotUsageRow,
} from "@openbot/ui/features/account/account-usage-view";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal } from "solid-js";
import { useAuth } from "../account/account-context";
import { useAgents } from "../agents/agents-context";
import { withHostAccountUsage } from "../agents/host-provider-accounts";

/** One row per provider account of the active server, plus the Grok Bot account when it is signed in. */
export function usePlanLimitRows() {
  const text = useText();
  const auth = useAuth();
  const { agentStatus, hostAccountLimits } = useAgents();
  const [grokRow, setGrokRow] = createSignal<AccountUsageProviderRow | null>(null);
  createEffect(
    () => text,
    (labels) => {
      const api = window.openbot.grokBot;
      void api.getStatus().then(async (status) => {
        if (!status.signedIn) {
          setGrokRow(null);
          return;
        }
        const summary = await api.getUsage();
        setGrokRow(
          summary
            ? grokBotUsageRow(summary, {
                name: labels.t("account.usage.grokBot"),
                included: labels.t("account.usage.grokBot.included"),
                onDemand: summary.onDemand
                  ? labels.t("account.usage.grokBot.onDemandLabel", {
                      used: labels.format.currencyUsd(summary.onDemand.usedUsd),
                      limit: labels.format.currencyUsd(summary.onDemand.limitUsd),
                    })
                  : "",
                formatReset: (date) =>
                  labels.format.date(date, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
              })
            : null,
        );
      });
    },
  );
  return createMemo(() => {
    const rows = accountUsageProviderRows(
      withHostAccountUsage(auth.accountUsage(), hostAccountLimits()),
      agentStatus().providers,
      text,
    );
    const extra = grokRow();
    // The grok-bot agent provider also reports the same quota as a provider row; keep only the richer account row.
    return extra ? [...rows.filter((row) => row.provider !== "grok-bot"), extra] : rows;
  });
}
