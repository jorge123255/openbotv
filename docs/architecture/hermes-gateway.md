# Hermes remote gateway foundation

This document describes the main-process foundation introduced in fork PR #44. The
[setup layer](hermes-gateway-setup.md) adds desktop settings, a system-browser password broker and
profile selection around it. The adapter starts no connection when OpenBot starts. The local
Hermes importer is unchanged.

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

The cookie-based foundation flow is `GET /api/status`, `GET /api/auth/providers`, JSON
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
- The HTTP adapter accepts fixed discovery, login, identity, profile and ticket routes. The setup
  layer adds the fixed native token exchange route. It follows no redirect, including 307 and 308.
  Credentials cannot move to another origin or proxy prefix. The login response's `next` URL
  is never followed. URL user information, queries, fragments and ambiguous paths are refused.
- Discovery sends and accepts no session cookie. Authenticated replies accept only host-only,
  HttpOnly Hermes session cookies with a matching path and valid expiry. HTTPS cookies must be
  Secure. The jar accepts the `__Host-`, `__Secure-` and gateway-suffixed Hermes names.
  Cookie type comes from the anchored full-name match, never a substring in the gateway suffix.
  The pinned gateway emits a 16-character hex suffix. Adversarial fixture names also test the
  adapter's broader accepted suffix grammar, including token names with provider-hint text.
- Cookie attributes, path and expiry are checked before secret registration. Accepted AT, RT and
  binding values are registered in both their original wire form and their decoded raw form.
  Starlette can quote the padded base64 that the password provider emits; transport keeps those
  original wire bytes. Nonsecret provider routing hints are not registered. Secret cookies shorter
  than 16 decoded characters are rejected, so a remote reply cannot register tiny words globally.
  This floor supports the pinned bundled tokens; shorter custom-provider tokens are unsupported.
- Passwords and tickets also use the shared secret redactor. The adapter writes no log. Typed failures contain a fixed code and no remote response, URL, headers or cause.
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

The tests cover password login, cookie rotation, profile projection, simultaneous accounts at the
same address, local sign-out/reconnect, expiry, rate limiting, socket refusal, a lost login response,
malformed and oversized responses, invalid cookies, secret redaction, redirects and cancellation.
HTTPS and WSS certificate rejection are separate cases. Secure cookies at a proxy prefix and
Host cookies at the gateway root both use the full gateway-suffixed cookie set.

`scripts/hermes-gateway-cookie-fixture.ts` models the pinned basic provider's compact JSON,
HMAC-SHA256 and padded URL-safe base64 token shape. It quotes padded values as Python SimpleCookie
does, and sends AT, RT, provider and sign-in binding cookies together. It models the cookie
middleware's two refresh paths: an expired AT still in the jar, and an AT evicted from the jar.
The gateway serves the original request and returns replacement AT/RT/provider/binding cookies.
The adapter keeps those replacements, keeps accounts separate, and makes no extra request.
A rejected binding or final 401 clears local authentication. There is no client refresh endpoint
or password replay. The fixture checks raw, wire and structured token redaction and proves that
rejected cookies, short secret values and provider hints do not change unrelated log masking.
Adversarial suffix cases check that AT, RT and binding cookies keep secret protection, that short
values still fail the token-length rule, and that genuine provider hints remain nonsecret.

The socket fixture enforces one-use tickets and TTL, refuses an expired ticket without replay,
and supports cancellation before upgrade admission. It checks REST/WS Origin headers and exact
proxy-prefix routing. The TLS fixture changes the server certificate after successful REST auth
to prove that WSS rejects an untrusted certificate before the ticket header reaches the server.

These fixtures model source behavior; they do not execute the pinned Python gateway. They do not
prove live Hermes compatibility, cross-process refresh races, an actual reverse-proxy deployment,
provider outages during refresh, or older/custom gateway versions. The pinned basic provider's
stateless refresh token can remain valid after rotation; the fixture checks that this client uses
the replacement, rather than claiming that Basic enforces one-use refresh tokens. A direct
adversarial replay against a live server and server-side ticket TTL enforcement remain unverified.
A transient refresh 503 currently discards the adapter's local session and requires explicit
sign-in; cookie-preserving outage recovery is not implemented.

## Setup and remaining work

The [desktop setup layer](hermes-gateway-setup.md) implements password-provider sign-in through
the pinned gateway's native PKCE broker and system browser. It adds explicit consent for address
and profile metadata. It keeps native credentials in memory and does not start chat or create an
agent. The direct cookie login remains covered by the foundation fixtures.

OAuth providers, native refresh, profile-scoped JSON-RPC, chat sessions, streaming, approvals,
automatic reconnect, credential persistence, remote revocation and remote HTTP exceptions remain
deferred. A reconnect must never replay an uncertain turn or approval.
