# Account quota in local conversations

The Ollama Cloud row uses an existing saved OpenAI-compatible connection. It does not read CLI
credential files, acquire a key, or change a saved connection. Open the row above the composer to
see included usage windows, their reset times, the purchased credit balance, and the last check.

## Binding and data

Main resolves the local agent, exact saved model, harness, and released model catalog. A connection
must use the official `https://ollama.com` origin with the root or `/v1` path, a saved API key, and
no custom headers. A local Ollama daemon or a cloud model name does not establish an account.
An endpoint waiting for a harness restart is not eligible.

The adapter calls only [`GET /api/balance`](https://docs.ollama.com/api/balance). It sends the saved
key to that fixed origin. Redirects, cookies and saved custom headers are refused. The request has
an eight-second deadline and a 32 KiB body limit. Errors and provider response text are not returned
to the renderer. There are no Team API routes for this feature.

For a current included period with a positive allowance and a consistent balance, used percentage
is `(allowance - balance) / allowance * 100`. Legacy session and weekly windows use
`100 - remaining_percent`, each with its own reset. Invalid, missing or expired windows stay
unknown. Purchased credits have no quota denominator and remain an amount. Exhausted included
allowance does not mean purchased credits are exhausted. Cloud history is not a quota denominator.

One main-process owner serializes requests across app windows and credentials. At most one request
starts per minute. Waiting visible pools take turns. HTTP 429 respects both seconds and HTTP-date
`Retry-After` values. Multiple saved keys can belong to one user or team, so separate keys do not
prove independent quota pools. Identical keys share a process-local pool and warning latch.

The last successful receipt time is called “Last checked”; Ollama does not supply an observation
timestamp in the documented balance response. A failed check makes the old reading stale at once.
A reading older than two minutes cannot warn. More than two active credential pools can therefore
have periods of unknown current headroom under the conservative shared request budget.

Connection changes clear the renderer reading before and after the write. Main aborts pending
requests and checks the binding again before publishing a result. No quota data is persisted.

## Warnings and model changes

A warning uses the raw percentage at or above 90. A rounded display value cannot trigger it.
Each credential pool and window has one warning episode. Dismissal applies across local app windows.
A new reset window or a fresh recovery below 85% rearms it; failures and unknown data do not.
The latches last for this application process. Restarting can show a current high-usage warning again.

The alternative list prefers saved backup models, then available catalog models. This first step
suggests only native Codex or Claude accounts with a known account identity. Other Ollama models
and different Ollama keys are not offered as independent allowance. A suggested account's cost and
remaining quota are labeled unknown. Availability is not a headroom guarantee.

Review switch opens a confirmation that names the model, provider and account, and explains that
the next turn sends conversation context to that provider. Main's existing model update flow queues
the runtime change while work is active. The notice does not stop a turn, send a message, release
a usage hold, or reset a conversation. The caller rechecks the source binding, warning episode,
target account identity, model availability and active confirmation before selecting the model.

## Kimi CLI and Devin CLI

Automated account quota is unavailable for these integrations in this change. No percentage is
inferred from session tokens or context occupancy. No authenticated CLI is launched.

- Kimi's native TUI `/usage` can show plan quota without inference, but its managed usage service
  can refresh OAuth. ACP `/usage` currently reports session/context tokens. The experimental
  [local server API](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/server-api.md)
  also calls the managed auth service. Native display needs a separate, explicit user-controlled
  integration and permission for that refresh behavior. `kimi -p "/usage"` can submit model input.
- Devin's [stable changelog](https://docs.devin.ai/cli/changelog/stable) documents native `/usage`
  account totals, limits and quota windows in some versions/plans. Its
  [ACP command list](https://docs.devin.ai/cli/reference/commands) advertises `/session-stats`,
  which concerns the current session. A private empty usage session would measure the wrong session.
  No supported structured self-serve account quota feed or safe print-mode dispatch was established.

A future native terminal view can show the CLI's output transparently. It must own its terminal,
protect drafts, avoid resuming an active conversation, check command readiness and installed version,
and keep raw display separate from automatic 90% decisions. Terminal scraping is not a stable quota
contract. There is no native-output panel in this first step.

## Isolated verification

- `bun scripts/ollama-quota-e2e.ts`: real service, injected HTTP/clock/configs, no account access.
- Start isolated Storybook, then `bun scripts/ollama-quota-ui-e2e.ts --url=http://localhost:6006`:
  shared notice, themes/widths, unknown and stale states, real conversation adapter, draft preservation,
  and target-account changes during confirmation.

Reports and screenshots go under `.openbot-build/ollama-quota-e2e` and
`.openbot-build/ollama-quota-ui-e2e`. CI publishes these as fixture evidence.
