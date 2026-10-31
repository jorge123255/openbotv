import type { KimiCliUsageSnapshot } from "@openbot/contracts/ipc";
import { NativeCliUsageDialog } from "@openbot/ui/features/account/NativeCliUsageDialog";
import { nativeCliUsageRows } from "@openbot/ui/features/account/native-cli-usage-view";
import { PageRail } from "@openbot/ui/features/window/PageRail";
import { useText } from "@openbot/ui/text";
import { createSignal, createStore, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const now = Date.UTC(2026, 9, 31, 12);
const initial: KimiCliUsageSnapshot = {
  connected: true,
  port: 58627,
  state: "ready",
  reason: null,
  checkedAt: now,
  retryAt: now,
  windows: [
    { id: "limit5h", usedRatio: 0.895, resetsAt: now + 7_200_000 },
    { id: "limit7d", usedRatio: 0.05, resetsAt: now + 4 * 86_400_000 },
    { id: "monthTotal", usedRatio: 0.2, resetsAt: null },
    { id: "monthCode", usedRatio: 0.05, resetsAt: null },
  ],
  extraBalanceCents: 250,
  currency: "USD",
};
function NativeCliUsagePreview(props: { mode?: "fresh" | "stale" | "unknown" | "connect" | "expired" | "before" }) {
  const text = useText();
  const [open, setOpen] = createSignal<"kimi" | "devin" | null>(null);
  const [state, setState] = createStore({
    reading: props.mode === "connect" ? null : initial,
    reads: 0,
    disconnects: 0,
  });
  const reading = (): KimiCliUsageSnapshot | null => {
    if (!state.reading) return null;
    if (props.mode === "unknown")
      return { ...state.reading, windows: [{ id: "limit5h", usedRatio: null, resetsAt: null }] };
    if (props.mode === "expired")
      return {
        ...state.reading,
        windows: state.reading.windows.map((window) =>
          window.id === "limit5h" ? { ...window, resetsAt: now - 1 } : window,
        ),
      };
    return state.reading;
  };
  const clock = () => (props.mode === "stale" ? now + 120_000 : now);
  const rows = () => nativeCliUsageRows(reading(), clock(), text);
  const row = () => rows().find((row) => row.id === open());
  return (
    <div class="app-window" style={{ height: "100vh" }}>
      <PageRail
        hidden={false}
        current="agents"
        pinned={[]}
        onPinChange={() => undefined}
        usageRows={[]}
        nativeUsage={props.mode === "before" ? undefined : { rows: rows(), now: clock(), onOpen: setOpen }}
        onAgents={() => undefined}
        onUsage={() => undefined}
        onSettings={() => undefined}
        help={null}
      />
      <output aria-label="Fixture actions">{`reads=${state.reads}, disconnects=${state.disconnects}`}</output>
      <Show when={row()}>
        {(row) => (
          <NativeCliUsageDialog
            row={row()}
            snapshot={reading()}
            now={clock()}
            busy={false}
            error={false}
            onConnect={() =>
              setState((draft) => {
                draft.reads++;
                draft.reading = { ...initial, windows: initial.windows.map((window) => ({ ...window })) };
              })
            }
            onRead={() =>
              setState((draft) => {
                draft.reads++;
              })
            }
            onDisconnect={() =>
              setState((draft) => {
                draft.disconnects++;
                draft.reading = null;
              })
            }
            onClose={() => setOpen(null)}
          />
        )}
      </Show>
    </div>
  );
}
const meta = { title: "Window/NativeCliUsage", component: NativeCliUsagePreview } satisfies Meta<
  typeof NativeCliUsagePreview
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Fresh: Story = {};
export const Stale: Story = { args: { mode: "stale" } };
export const Unknown: Story = { args: { mode: "unknown" } };
export const Connect: Story = { args: { mode: "connect" } };
export const Expired: Story = { args: { mode: "expired" } };
export const Before: Story = { args: { mode: "before" } };
