# Hermes remote gateway foundation

This is an internal main-process adapter. It is not connected to the application service graph,
IPC, settings or agent creation. No connection starts when OpenBot starts. The local Hermes
importer is unchanged.

## Pinned protocol

The source is official Hermes Agent commit
[`f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f`](https://github.com/NousResearch/hermes-agent/tree/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f).
Protocol sources:

- [`hermes_cli/dashboard_auth/routes.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/hermes_cli/dashboard_auth/routes.py):
  provider discovery, JSON password login, identity and single-use socket tickets.
- [`hermes_cli/dashboard_auth/cookies.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/hermes_cli/dashboard_auth/cookies.py):
  cookie names, proxy paths, TLS prefixes and expiry.
- [`hermes_cli/web_server_boundary.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/hermes_cli/web_server_boundary.py)
  and [`hermes_cli/web_server_chat.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/hermes_cli/web_server_chat.py):
  the `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>` socket subprotocols.
- [`hermes_cli/web_routers/profiles.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/hermes_cli/web_routers/profiles.py):
  the read-only profile list.

The flow is `GET /api/status`, `GET /api/auth/providers`, JSON
`POST /auth/password-login`, cookie-authenticated `GET /api/auth/me` and `GET /api/profiles`,
then `POST /api/auth/ws-ticket` and one socket upgrade to `/api/ws`.
Provider name `basic` does **not** mean HTTP Basic authentication.

The adapter sends the ticket in a subprotocol header. It does not put a password, session token
or ticket in a URL. It selects only `hermes-gateway-v1` and closes the probe socket after the
upgrade. A successful result means that authentication, profile reads and the socket upgrade
worked. It does not mean that JSON-RPC chat works. No JSON-RPC frame is sent.

## Trust and resource ownership

- The main process owns an immutable gateway address and one cookie jar per connection object.
  Two accounts at the same address do not share cookies. No Chromium session is used.
- A remote address must use HTTPS. HTTP is accepted only for loopback IP addresses. A LAN or
  Tailscale HTTP exception is deferred. No VPN, proxy, firewall or DNS setting is changed.
- Both HTTPS and WSS require certificate validation, even when the process has a TLS bypass
  environment variable. There is no adapter option to disable this check.
- The HTTP adapter accepts six fixed routes. It follows no redirect, including 307 and 308.
  Credentials cannot move to another origin or proxy prefix. The login response's `next` URL
  is never followed. URL user information, queries, fragments and ambiguous paths are refused.
- Discovery sends and accepts no session cookie. Authenticated replies accept only host-only,
  HttpOnly Hermes session cookies with a matching path and valid expiry. HTTPS cookies must be
  Secure. The jar accepts the `__Host-`, `__Secure-` and gateway-suffixed Hermes names.
- Passwords, cookie values and tickets are registered with the shared secret redactor. The adapter
  writes no log. Typed failures contain a fixed code and no remote response, URL, headers or cause.
  Schema projection returns only profile names, optional display names and the default flag.
- Requests have an eight-second deadline and a 1 MiB response limit. Socket admission has an
  eight-second deadline and a 64 KiB frame limit. All transport failures discard the local session.
- Operations are serialized. `close()` aborts active I/O, clears the jar and makes the object
  unusable. A reconnect needs a new object and a new explicit sign-in. The object owns no open
  socket between calls. Its application owner must call `close()` on teardown when it is wired in.
- No operation retries. An uncertain password POST, ticket mint or socket upgrade is not replayed.
  No bot, conversation, local database, memory, skill, routine or network setting is written.

`close()` is local disconnect, not remote token revocation. Hermes expires the remote session.
The adapter does not save credentials or sessions across restarts.

## Verification

Run `node --import tsx scripts/hermes-gateway-e2e.ts`. It drives the real adapter against local
HTTP, HTTPS and WebSocket fixtures. It creates a temporary test certificate and key, then deletes
them. The trusted certificate is passed only to a synthetic child process. No real gateway or
user profile is read. The report is `.openbot-build/hermes-gateway-e2e/report.json`.
The provider-fakes CI job runs this check and uploads the report.

The tests cover password login, cookie rotation, profile projection, same-address account
isolation, local sign-out/reconnect, expiry, rate limiting, socket refusal, a lost login response,
malformed and oversized responses, invalid cookies, secret redaction, redirects, cancellation
and valid/invalid TLS. Fixtures model the pinned source; no live Hermes server was tested.

## Next stages

1. Add a login and profile-selection flow with sender-validated IPC, localized errors and a
   credential entry boundary that keeps secrets out of OpenBot's privileged renderer.
2. Implement the advertised native OAuth PKCE flow through the gateway and system browser.
   Add explicit cancellation, provider selection, state binding and refresh-rotation tests.
3. Add profile-scoped JSON-RPC, session identity, streaming, approval handling and reconnect.
   Preserve uncertain turn/approval state. Never replay these requests on reconnect.
4. Add an explicit decision for session persistence, remote logout and trusted LAN/VPN HTTP.

These stages are unavailable in this PR. The adapter does not import or create a remote agent.
