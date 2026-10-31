import type { ConnectKimiCliUsageInput, KimiCliUsageSnapshot } from "@openbot/contracts/ipc";
import { Button, Checkbox, Dialog, Field, Input } from "@openbot/ui";
import { createStore, createUniqueId, Show } from "solid-js";
import { useText } from "../../text";
import { NativeCliUsageDetails } from "./NativeCliUsageDetails";
import type { NativeCliUsageRailRow } from "./native-cli-usage-view";

// A command identifier, not interface text.
const SERVER_COMMAND = "kimi web --no-open";

/** Mounted only while open, so the unsaved bearer token is discarded on every close. */
export function NativeCliUsageDialog(props: {
  row: NativeCliUsageRailRow;
  snapshot: KimiCliUsageSnapshot | null;
  now: number;
  busy: boolean;
  error: boolean;
  onConnect: (input: ConnectKimiCliUsageInput) => void;
  onRead: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const { t } = useText();
  const id = createUniqueId();
  const [form, setForm] = createStore({ port: "58627", token: "", consent: false });
  const valid = () =>
    /^\d{1,5}$/.test(form.port) &&
    Number(form.port) > 0 &&
    Number(form.port) <= 65_535 &&
    /^[\x21-\x7e]{1,4096}$/.test(form.token);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="custom-provider-backdrop">
          <Dialog.Content as="section" class="native-cli-usage-dialog" aria-busy={props.busy ? "true" : undefined}>
            <Dialog.Title>{t("account.usage.native.title", { name: props.row.name })}</Dialog.Title>
            <Dialog.Description>{t("account.usage.native.description")}</Dialog.Description>
            <NativeCliUsageDetails row={props.row} now={props.now} />
            <Show when={props.row.id === "kimi"}>
              <Show when={props.snapshot?.port}>
                {(port) => <p>{t("account.usage.native.endpoint", { port: port() })}</p>}
              </Show>
              <Show when={!props.snapshot?.connected}>
                <p>{t("account.usage.native.setup")}</p>
                <code>{SERVER_COMMAND}</code>
                <p>{t("account.usage.native.permissions")}</p>
                <Field label={t("account.usage.native.port")}>
                  <Input
                    value={form.port}
                    inputmode="numeric"
                    maxlength={5}
                    disabled={props.busy}
                    onValueChange={(port) =>
                      setForm((draft) => {
                        draft.port = port;
                      })
                    }
                  />
                </Field>
                <Field label={t("account.usage.native.token")}>
                  <Input
                    type="password"
                    value={form.token}
                    autocomplete="off"
                    maxlength={4096}
                    disabled={props.busy}
                    onValueChange={(token) =>
                      setForm((draft) => {
                        draft.token = token;
                      })
                    }
                  />
                </Field>
              </Show>
              <label for={id} class="native-cli-usage-consent">
                <Checkbox
                  id={id}
                  checked={form.consent}
                  disabled={props.busy}
                  onChange={(event) =>
                    setForm((draft) => {
                      draft.consent = event.currentTarget.checked;
                    })
                  }
                />
                {t("account.usage.native.consent")}
              </label>
              <p>{t("account.usage.native.timeout")}</p>
              <Show when={props.error || props.snapshot?.state === "unavailable"}>
                <p role="alert">{t("account.usage.native.failed")}</p>
              </Show>
              <div class="native-cli-usage-actions">
                <Show
                  when={props.snapshot?.connected}
                  fallback={
                    <Button
                      type="button"
                      disabled={props.busy || !form.consent || !valid() || props.now < (props.snapshot?.retryAt ?? 0)}
                      onClick={() => {
                        props.onConnect({ port: Number(form.port), token: form.token, allowRefresh: true });
                        setForm((draft) => {
                          draft.token = "";
                          draft.consent = false;
                        });
                      }}
                    >
                      {t("account.usage.native.connect")}
                    </Button>
                  }
                >
                  <Button
                    type="button"
                    disabled={props.busy || !form.consent || props.now < (props.snapshot?.retryAt ?? 0)}
                    onClick={() => {
                      props.onRead();
                      setForm((draft) => {
                        draft.consent = false;
                      });
                    }}
                  >
                    {t("account.usage.native.read")}
                  </Button>
                  <Button type="button" variant="outline" onClick={props.onDisconnect}>
                    {t("account.usage.native.disconnect")}
                  </Button>
                </Show>
              </div>
            </Show>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              {t("common.close")}
            </Button>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
