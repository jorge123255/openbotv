import { KIMI_CLI_USAGE_FRESH_MS, type KimiCliUsageSnapshot } from "@openbot/contracts/ipc";
import { usageTone } from "@openbot/team-client/plan-limits";
import type { TextValue } from "../../text";
import type { AccountUsageWindowRow } from "./account-usage-view";

export type NativeCliUsageWindowRow = Omit<AccountUsageWindowRow, "remainingPercent"> & {
  remainingPercent: number | null;
};
export interface NativeCliUsageRailRow {
  id: "kimi" | "devin";
  name: string;
  status: string;
  detail: string;
  checked: string | null;
  wallet: string | null;
  breakdown: string | null;
  windows: NativeCliUsageWindowRow[];
}

/** A presentation only. Never enters AccountUsage, the send-limit store or warning decisions. */
export function nativeCliUsageRows(
  reading: KimiCliUsageSnapshot | null,
  now: number,
  text: TextValue,
): NativeCliUsageRailRow[] {
  const { t, format } = text;
  const fresh =
    reading?.state === "ready" &&
    reading.checkedAt !== null &&
    now >= reading.checkedAt &&
    now - reading.checkedAt < KIMI_CLI_USAGE_FRESH_MS;
  const stale = reading?.state === "ready" && !fresh;
  const windows = (reading?.windows ?? [])
    .filter((window) => window.id !== "monthCode")
    .map((window): NativeCliUsageWindowRow => {
      const remainingPercent =
        fresh && window.usedRatio !== null && (window.resetsAt === null || now < window.resetsAt)
          ? 100 * (1 - window.usedRatio)
          : null;
      const labels = {
        limit5h: t("account.usage.window.fiveHour"),
        limit7d: t("account.usage.window.weekly"),
        monthTotal: t("account.usage.window.monthly"),
        monthCode: t("account.usage.window.monthly"),
      };
      return {
        label: labels[window.id],
        remainingPercent,
        tone: usageTone(remainingPercent),
        resetsAt: window.resetsAt === null ? null : window.resetsAt / 1_000,
        resetsAtLabel:
          window.resetsAt === null ? null : format.date(window.resetsAt, { dateStyle: "medium", timeStyle: "short" }),
      };
    });
  if (!windows.length)
    windows.push(
      {
        label: t("account.usage.window.fiveHour"),
        remainingPercent: null,
        tone: "neutral",
        resetsAt: null,
        resetsAtLabel: null,
      },
      {
        label: t("account.usage.window.weekly"),
        remainingPercent: null,
        tone: "neutral",
        resetsAt: null,
        resetsAtLabel: null,
      },
    );
  const codeShare = reading?.windows.find((window) => window.id === "monthCode");
  return [
    {
      id: "kimi",
      name: "Kimi CLI",
      status:
        fresh && windows.some((window) => window.remainingPercent !== null)
          ? t("account.usage.native.reported")
          : stale
            ? t("account.usage.native.stale")
            : t("account.usage.value.unavailable"),
      detail:
        reading?.reason === "accountChanged" || reading?.reason === "serverChanged"
          ? t("account.usage.native.changed")
          : reading?.reason === "unsupported"
            ? t("account.usage.native.unsupported")
            : reading?.reason === "unsafe"
              ? t("account.usage.native.unsafe")
              : t("account.usage.native.source"),
      checked:
        reading?.checkedAt === null || !reading
          ? null
          : t("account.usage.native.checked", {
              time: format.date(reading.checkedAt, { dateStyle: "medium", timeStyle: "short" }),
            }),
      wallet:
        fresh && reading?.extraBalanceCents !== null && reading?.currency
          ? t("account.usage.native.wallet", {
              amount: format.number(reading.extraBalanceCents / 100, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
              currency: reading.currency,
            })
          : null,
      breakdown:
        fresh &&
        codeShare?.usedRatio !== null &&
        codeShare?.usedRatio !== undefined &&
        (codeShare.resetsAt === null || now < codeShare.resetsAt)
          ? t("account.usage.native.monthCode", { percent: format.percent(codeShare.usedRatio) })
          : null,
      windows,
    },
    {
      id: "devin",
      name: "Devin CLI",
      status: t("account.usage.value.unavailable"),
      detail: t("account.usage.native.devinGap"),
      checked: null,
      wallet: null,
      breakdown: null,
      windows: [
        {
          label: t("account.usage.window.limit"),
          remainingPercent: null,
          tone: "neutral",
          resetsAt: null,
          resetsAtLabel: null,
        },
      ],
    },
  ];
}
