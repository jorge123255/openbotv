# Native CLI account-quota rings

The local desktop rail has Kimi CLI and Devin CLI quota rings. These are separate from agent send
limits. Session tokens and context usage never fill these rings.

## Kimi CLI

This optional connection uses the experimental API of Kimi CLI 2.3.3. Start `kimi web --no-open`
yourself. Open the Kimi ring, then enter the numeric local port and existing bearer token. The
default port is 58627. OpenBot does not start the server, create a token, read credential files,
grant workspace trust or create a login.

The bearer token grants more than quota access: Kimi also accepts it for sessions, files and
terminals. Enter it only in an app that you trust. OpenBot keeps it in main-process memory and
registers it for log redaction. The connection ends on disconnect or app exit. The token is not
written to settings, SQLite, Keychain, exports or analytics. Disconnect does not revoke the token
at the Kimi server.

Each Connect and read or Read quota action needs explicit consent. Kimi can refresh its existing
OAuth sign-in as part of these reads. Closing the panel, timeout or disconnect cannot undo a refresh
already started by Kimi. No server request runs on hover, mount, a timer or a server switch. A timer
reads OpenBot's cached state only, so other windows see disconnect and readings become stale.
The process permits at most one explicit read sequence per minute, including reconnects.

The reader uses GET only, on fixed `127.0.0.1` routes: metadata, managed Kimi Code user info, quota,
user info again, then metadata again. It forbids redirects and cookies, bounds each body to 64 KiB
and the sequence to 15 seconds, rejects an authentication-disabled server, and pins the verified
version, server identity and private account identity. Detected changes clear all quota data and
require reconnect. User IDs and arbitrary profile or server fields do not cross IPC.

The API does not bind quota and account identity in one response. Before/after checks cannot detect
an account change from A to B and back to A during the request. The panel states this limit. It shows
a reported snapshot, never proof of the account used by an OpenBot agent. The server version and
identity are self-reported, not a signature. Use a local server and token whose source you know.

The API reports used ratios, not token counts. The rings show the remaining amount in its plan
windows. Details show approximately rounded used percentages, reset countdowns and the last
successful receipt time. Provider measurement time is not available. Data loses active arcs after
two minutes or a reported reset. Missing, invalid or expired values stay unknown; they never become
zero. Missing reset times stay explicit. Monthly code usage is a share of monthly quota, not a new
allowance. Purchased Extra Usage balance is separate from plan quota.

These readings do not cause 90% warnings, alter send limits, recommend a model or change a model.
That requires an account-bound quota source with an atomic response contract.

## Devin CLI

Some versions and plans show account quota in native `/usage`. A safe structured quota path has not
been verified for this integration. ACP session statistics do not give account quota. The ring is
neutral and says Unavailable. No Devin process is launched or given a command by this feature.

## Verification

`bun scripts/kimi-cli-usage-e2e.ts` runs the actual reader and service with injected HTTP responses
and clock. It starts no listener or CLI. Its report is in `.openbot-build/kimi-cli-usage-e2e/`.

`bun scripts/native-cli-usage-ui-e2e.ts --url=http://localhost:6006` drives the shared rings and
consent dialog in isolated Storybook fixtures. Its report and screenshots are in
`.openbot-build/native-cli-usage-ui-e2e/`. The CI Storybook lane runs both checks.

Boundary cases are in `src/preload/kimi-cli-usage-decoding.test.ts`. Full native CLI startup and
the local web API are not exercised by these mock checks. A separate approved native `/usage`
check on 2.3.3 succeeded without a model prompt; that did not verify the web API transport.

Official API contract:
[Kimi CLI 2.3.3 server API](https://github.com/MoonshotAI/kimi-code/blob/ec495f0cb00f6db9a9118bf979112886f4264a41/docs/en/reference/server-api.md).
