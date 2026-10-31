import { For, Show } from "solid-js";
import { useText } from "../../text";
import { AccountUsageWindowList } from "./AccountUsageDetails";
import type { NativeCliUsageRailRow } from "./native-cli-usage-view";

export function NativeCliUsageDetails(props: { row: NativeCliUsageRailRow; now: number }) {
  const { t, format } = useText();
  return (
    <div class="native-cli-usage-details">
      <h2 class="account-usage-popover-title">{props.row.name}</h2>
      <p role="status">{props.row.status}</p>
      <AccountUsageWindowList windows={props.row.windows} now={props.now} />
      <For each={props.row.windows}>
        {(window) => (
          <p>
            {window.remainingPercent === null
              ? t("account.usage.native.windowUnknown", { window: window.label })
              : t("account.usage.native.used", {
                  window: window.label,
                  percent: format.percent(1 - window.remainingPercent / 100),
                })}
          </p>
        )}
      </For>
      <Show when={props.row.windows.some((window) => window.resetsAt === null)}>
        <p>{t("account.usage.native.resetUnknown")}</p>
      </Show>
      <p>{props.row.detail}</p>
      <Show when={props.row.checked}>{(checked) => <p>{checked()}</p>}</Show>
      <Show when={props.row.wallet}>{(wallet) => <p>{wallet()}</p>}</Show>
      <Show when={props.row.breakdown}>{(breakdown) => <p>{breakdown()}</p>}</Show>
    </div>
  );
}
