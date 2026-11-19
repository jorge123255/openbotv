import { DEFAULT_PROVIDER_ACCOUNT_ID } from "@openbot/contracts/ipc";
import { spentUsageWindow, usageTone } from "@openbot/team-client/plan-limits";
import {
  type AccountUsageProviderRow,
  accountUsageProviderRows,
  formatUsageReset,
  grokBotUsageRow,
} from "@openbot/ui/features/account/account-usage-view";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal } from "solid-js";
import { useTurns } from "../../turns";
import { useAuth } from "../account/account-context";
import { useAgents } from "../agents/agents-context";
import { withHostAccountUsage } from "../agents/host-provider-accounts";

/**
 * One row per provider account of the active server, for the rail rings, plus the Grok Bot account
 * when it is signed in. A model that the plan refused adds a used-up line with its own name to its
 * account, and the ring shows it: a limit of one model, such as a separate weekly limit, is not in
 * the account's 5-hour and weekly windows, which then show usage left.
 */
export function usePlanLimitRows() {
  const text = useText();
  const auth = useAuth();
  const { agentStatus, hostAccountLimits, agentList, modelOptions } = useAgents();
  const { usageLimits, usageLimitedModels } = useTurns();
  const [grokRow, setGrokRow] = createSignal<ReturnType<typeof grokBotUsageRow>>(null);
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
  return createMemo((): AccountUsageProviderRow[] => {
    const usage = withHostAccountUsage(auth.accountUsage(), hostAccountLimits());
    const base = accountUsageProviderRows(usage, agentStatus().providers, text);
    const now = Date.now();
    const held = usageLimitedModels().filter((limit) => {
      const account = limit.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
      const spent = spentUsageWindow(usage?.limits, limit.provider, account, limit.model, now);
      const ownWindow = usage?.limits.some(
        (reading) => reading.primary === spent?.window || reading.secondary === spent?.window,
      );
      return !(spent?.covers && !spent.onCredits && ownWindow);
    });
    const rows =
      held.length === 0
        ? base
        : base.map((row) => {
            const account = row.accountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
            const limits = usageLimits();
            const windows = held
              .filter(
                (limit) =>
                  limit.provider === row.provider &&
                  (limit.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) === account,
              )
              .map((limit) => {
                // The reset is the one of an agent that the limit holds.
                const agent = agentList().find(
                  (candidate) =>
                    candidate.id in limits &&
                    candidate.provider === limit.provider &&
                    candidate.model === limit.model &&
                    (candidate.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) === account,
                );
                const resetsAt = agent ? (limits[agent.id] ?? null) : null;
                return {
                  label:
                    modelOptions().find((option) => option.provider === limit.provider && option.id === limit.model)
                      ?.name ?? limit.model,
                  remainingPercent: 0,
                  tone: usageTone(0),
                  durationMins: null,
                  resetsAt,
                  resetsAtLabel: formatUsageReset(resetsAt, text),
                };
              });
            // The used-up model stops work first, so the ring and the chip show it, as for a used-up Cursor window.
            return windows.length
              ? {
                  ...row,
                  windows: [...row.windows, ...windows],
                  ringWindows: windows,
                  remainingPercent: 0,
                  tone: usageTone(0),
                }
              : row;
          });
    const extra = grokRow();
    // The grok-bot agent provider also reports the same quota as a provider row; keep only the richer account row.
    if (!extra) return rows;
    const grok: AccountUsageProviderRow = {
      ...extra,
      windows: extra.windows.map((window) => ({ ...window, durationMins: null })),
      ringWindows: extra.ringWindows.map((window) => ({ ...window, durationMins: null })),
    };
    return [...rows.filter((row) => row.provider !== "grok-bot"), grok];
  });
}
