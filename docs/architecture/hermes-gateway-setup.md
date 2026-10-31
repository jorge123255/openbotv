# Hermes gateway setup

This change is stacked on fork PR #44 (`feat/hermes-gateway-foundation`, base commit `722a3cdb9`).
It adds a desktop settings flow to the secured adapter. The stack must be reviewed with #44.
The official protocol remains pinned to Hermes Agent
[`f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f`](https://github.com/NousResearch/hermes-agent/tree/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f).

## Available flow

Settings → Hermes gateways accepts an explicit ASCII HTTPS address (use punycode for international hostnames), checks `/api/status` and
`/api/auth/providers`, and lists the advertised providers. A password provider is supported only
when the gateway advertises `native_pkce`. Older cookie-only gateways and OAuth providers are
shown as unsupported. Remote HTTP, SSH URLs and credential-bearing URLs are refused. Loopback IP
HTTP remains available for local gateways and synthetic tests.

Sign in with browser opens `/auth/native/authorize` with a main-generated S256 challenge, state
and ephemeral `127.0.0.1` callback. The pinned gateway supports this broker for password providers:
[`routes.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/hermes_cli/dashboard_auth/routes.py)
redirects to its own `/login` page. That page owns password entry. OpenBot does not embed the page
or add a password field, and does not give its privileged renderer a callback URL, authorization
URL, code, verifier or token.

The callback checks the method, exact Host and random path, absence of Origin, unique state/code
parameters, ASCII state and a constant-time state comparison. Invalid callbacks do not end the
login or redeem a code. A valid callback is consumed once. The listener uses no-store, no-referrer
and a deny-all CSP, expires after three minutes, and closes on success, failure, cancel or shutdown.

The code is exchanged once at `/auth/native/token`, directly with the same validated gateway.
No redirect or retry is allowed. The main process verifies identity, reads profiles and checks one
socket upgrade with a fresh ticket in a subprotocol header. Native REST uses a memory-only bearer;
browser session cookies are not copied into OpenBot. The UI receives only bounded setup metadata,
provider choices, profile labels, expiry and selection state.

Selecting a returned profile saves the choice in memory. The UI states that remote chat is not
available. Selection does not import, create, change or connect an OpenBot agent to chat.

## Persistence and consent

Remember is off by default. Turning it on and selecting a profile invokes a native confirmation
that names the exact address and profile. A renderer flag alone cannot save the connection.
Only `{id, url, profileId}` entries are written to `openbot-hermes-gateways-v1.json` in userData.
The file is atomic and local. No password, token, authorization URL or gateway session is written.

A missing file is a first run. Unknown versions, extra fields and unreadable content make the
store read-only so a write cannot erase data from a newer format. Writes are serialized.
Remembered entries load signed out and send no startup request. Re-check and sign-in are explicit.
Unchecking Remember removes the saved metadata. Disconnect cancels pending sign-in and clears the
local session. Remove also removes the row and its remembered metadata. Existing agents, local
Hermes imports, workspaces, skills, routines and databases are not modified.

`HermesGatewaySetupService` owns setup state and the dedicated metadata file. Each connection owns
its bearer and request cancellation. Public discovery is serialized and limited to eight rows.
Application teardown aborts connections, waits for the native callback/transport operations to
unwind, and waits for metadata writes. No operation replays an uncertain code exchange, socket
admission, turn or approval. There are no turn or approval methods in this stage.

## Boundaries

Six local-only IPC methods use the existing trusted-sender registrar and bounded input parsers.
They accept addresses, IDs and an explicit remember choice. They accept no credentials. The preload
has a separate response decoder that drops unknown fields and rejects unsafe URLs or malformed
setup replies. There is no Team API route and no account-service or mobile endpoint.

The system browser necessarily sees the gateway authorization request and the gateway's one-use
loopback code in a URL. This is the pinned native protocol, not a session-token URL. Codes are
PKCE-bound, consumed once and never sent to the app renderer or diagnostics. Browser history and
browser sign-out remain with the system browser. OpenBot does not revoke the gateway's token at
disconnect. Main failures cross IPC as fixed localized source messages without remote bodies,
headers, URLs, parser input or causes. New UI text has English source keys; other locales use the
existing English fallback until translated.

## Verification

- `node --import tsx scripts/hermes-gateway-setup-e2e.ts` drives the real service, native broker,
  main HTTP/socket adapters, metadata file and injected browser launcher against a synthetic
  gateway. The browser driver models the pinned password form and PKCE code exchange.
- The six groups cover sign-in, wrong/duplicate/non-ASCII state and code, wrong path/Host/Origin/
  method, concurrent identities, profile validation, native remember consent, restart without
  network, unremember/remove, expiry, unknown metadata formats, missing capabilities, OAuth
  refusal, invalid PKCE, redirecting token exchange and shutdown during sign-in.
- `src/preload/hermes-gateway-decoding.test.ts` protects the IPC projection and credential-free
  input shape. `src/main/ipc-channel-coverage.test.ts` verifies the new bridge group.
- `scripts/hermes-gateway-setup-ui-e2e.ts` uses only synthetic Storybook ports. It checks setup,
  profile selection, persistence choice, disconnect/reconnect, remove, signed-out restoration,
  unsupported providers and cancellation. It records desktop and narrow before/after images.
- The foundation's 13-group gateway/security suite remains in CI. Setup reports live under
  `.openbot-build/hermes-gateway-setup-e2e/` and `.openbot-build/hermes-gateway-setup-ui-e2e/`.
  CI runs and uploads both.

No real Hermes gateway, system-browser password login, native OS confirmation, live Electron app,
network configuration or production build was exercised. Synthetic fixtures do not establish live
interoperability. The UI was checked in isolated Storybook.

## Deferred

Remote chat, JSON-RPC sessions, agent creation, streaming, approvals, OAuth providers, SSH,
remote HTTP exceptions, automatic connection, native token refresh, saved credentials and remote
revocation are unavailable. Native bearer expiry clears the local session and requires a fresh
explicit sign-in. A browser that cannot complete a loopback redirect has no fallback in this stage.
