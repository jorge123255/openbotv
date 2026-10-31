import { For, Show } from "solid-js";
import type { AccountUsageTone } from "../account/account-usage-view";

/** The same remaining-quota rings for provider and native CLI readings. Null is an empty track. */
export function UsageRingGraphic(props: {
  windows: readonly { remainingPercent: number | null; tone: AccountUsageTone }[];
}) {
  const ring = { size: 34, stroke: 2.25, spacing: 4.5 };
  const outerRadius = (ring.size - ring.stroke) / 2;
  return (
    <svg class="window-rail-usage-ring" viewBox={`0 0 ${ring.size} ${ring.size}`} fill="none" aria-hidden="true">
      <For each={props.windows.slice(0, 2)} keyed={false}>
        {(window, index) => (
          <g>
            <circle
              class="window-rail-usage-track"
              cx={ring.size / 2}
              cy={ring.size / 2}
              r={outerRadius - index * ring.spacing}
              stroke-width={ring.stroke}
            />
            <Show when={(window().remainingPercent ?? 0) > 0}>
              <circle
                class="window-rail-usage-arc"
                data-usage-tone={window().tone}
                cx={ring.size / 2}
                cy={ring.size / 2}
                r={outerRadius - index * ring.spacing}
                stroke-width={ring.stroke}
                stroke-linecap="round"
                pathLength={100}
                stroke-dasharray={`${window().remainingPercent} 100`}
              />
            </Show>
          </g>
        )}
      </For>
    </svg>
  );
}
