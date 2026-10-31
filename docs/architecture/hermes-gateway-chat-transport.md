# Hermes canonical session transport

This is an internal transport stage stacked on [gateway setup](hermes-gateway-setup.md), fork
PR #51, which depends on #44. It adds no chat UI, IPC method, agent provider, database write or
automatic network operation. The Settings notice that remote chat is unavailable remains true.

## Supported boundary

An authenticated native-bearer `HermesGatewayConnection` can create at most four transports. Each transport
has one immutable account owner, validated profile name and explicit session ID. Creating it only
validates membership in the authenticated profile list. A caller must explicitly connect and attach
an existing session. Empty/path-like profile selectors, session aliases and a different session ID
are refused; no default-profile or local-agent fallback exists.

The wire is pinned to official Hermes Agent
[`f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f`](https://github.com/NousResearch/hermes-agent/tree/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f):

- [`tui_gateway/ws.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/tui_gateway/ws.py)
  sends canonical readiness and coalesces newline-delimited JSON-RPC in a WebSocket message.
- [`canonical_sessions.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/tui_gateway/contracts/canonical_sessions.py)
  and [`canonical.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/tui_gateway/contracts/canonical.py)
  define snapshots, admission receipts and generation-fenced controls.
- [`session_controls.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_controls.py)
  routes explicit profiles and serves `runtime.describe`. Describe itself is a closed unscoped RPC;
  the selected profile's snapshot establishes its canonical identity. That identity must stay the
  same across reconnects. Sessions without the local snapshot's profile identity are unsupported.
- [`session_events.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_events.py),
  [`session_authority.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_authority.py)
  and [`session_pending_controls.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_pending_controls.py)
  define event ordering, pending state, approval and clarification settlement.

Connect mints a new single-use ticket and sends it in the `hermes-gateway-ticket.*` subprotocol
beside `hermes-gateway-v1`. It requires canonical readiness, heartbeat support, durable admissions
and event replay capability. A legacy sidecar or missing capability fails closed. It does not
negotiate an older protocol. TLS certificates, fixed origin/proxy prefix and no redirects retain
the foundation's transport rules. A ticket, bearer or password never enters a socket URL.

Every session RPC includes the selected profile, even `default`. Each profile/session uses its own
socket: the pinned session events need not contain a profile label. Replies must name the requested
session and canonical profile. Foreign session events are ignored; an explicit conflicting profile,
changed epoch, event gap or malformed frame closes that transport. Other profiles and accounts
remain separate. A native token's expiry or account disconnect closes its owned transports.
Direct cookie-authenticated connections remain foundation-only; this stage requires native sign-in.
Cancelling a ticket request stops that request without signing out sibling profiles. A refused
unlisted profile or transport count limit also preserves existing transports. An authentication
refusal invalidates the account owner.

## Turns, events and controls

Attach requests `session.resume` with `omit_messages: true`. It reads a bounded control snapshot,
not transcript history. Events that race this snapshot are buffered, then checked against its
watermark. A lost socket between a snapshot reply and its adoption cannot restore an attachment.

`submit(text)` sends one unqueued plain-text input with a new submission ID. It refuses overlapping
or unresolved pending work. The admission receipt must match the session/profile/authority before
the call reports acceptance. A completion that arrives before its receipt cannot leave a false
running state or pending row. No attachment, slash-command or launch-policy option is accepted.

`readEvent()` has one consumer and returns projected text deltas,
text completions, scalar approval/clarification requests and prompt settlement. Known credential
values are redacted from displayed text and choice labels. A private `RegisteredSecretStream`
holds suffixes that can still become a registered raw, JSON-escaped or URL-encoded secret after
another chunk. It uses a cached prefix automaton and retains at most 32,768 UTF-16 units. Complete
overlapping matches are kept whole. Overflow closes the socket; an unfinished candidate is masked
at a segment/turn boundary and discarded on detach. Credentials must be registered before their
first chunk. Generic unregistered pattern rules still run on each released prefix. Raw segment
and offset hints are not exposed: redacted output has different chunk boundaries and lengths.
Unknown remote fields and rendered HTML are not projected.
Sequence duplicates and older execution generations are discarded. `session.info` also advances
the generation when only its payload carries it. A generationless queued cancellation cannot end
another running turn or remove its prompts. Non-text completions require a later adapter.

The pinned owner also publishes `session.info` with local settings/model/profile inventory at
turn completion and policy refresh, through
[`session_local_inventory.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_local_inventory.py)
and [`session_policy_refresh.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_policy_refresh.py).
That variant validates the current canonical profile identity and is otherwise ignored. Any
control field selects the full strict control schema: partial/malformed controls cannot fall back
to harmless metadata. Conflicting profile identities close the
transport. Settings metadata cannot clear pending admissions, running state or prompts.

Approvals need an exact current prompt ID, generation and explicit advertised `once` or `deny`
choice. Session/permanent grants, edit approvals, multi-select and batch clarification are not
supported. Scalar clarification takes an explicit bounded answer. There is no default answer or
response to the next arbitrary prompt. A sent response spends that prompt for this transport's
lifetime, including after a lost acknowledgement and a replayed snapshot.

The client advertises no server-request handlers and is not a local Hermes Desktop. Unexpected
server requests are ignored locally. The pinned broker can resolve a broadcast globally on an
error response ([`session_server_requests.py`](https://github.com/NousResearch/hermes-agent/blob/f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f/gateway/session_server_requests.py)), so sending a method-not-supported error could cancel a capable viewer's shared
sudo/secret/batch prompt. This viewer neither answers nor cancels that request; capable viewers
and the server's own deadline retain ownership. Sudo, setup, plugin, file, browser and host-tool
requests cannot execute anything in OpenBot.

`interrupt()` explicitly sends the captured execution generation. It never guesses a newer turn
after a stale response. Disconnect is a local socket detach, not remote cancellation or sign-out.
Cancelling a pending event read removes only that wait. Cancelling an in-flight mutation closes
the socket and treats its remote outcome as uncertain.

## Reconnect and uncertainty

There is no automatic reconnect, request queue or retry. Explicit reconnect obtains a fresh ticket
and capabilities but attaches nothing. A caller must explicitly resume the same session again.
There is no event replay or transcript backfill in this stage; a gap requires a fresh snapshot,
and text lost while disconnected remains unavailable here.

Once a mutation's send is attempted, a lost/error/malformed acknowledgement leaves a main-owned
uncertainty record. Up to eight independent records are retained. Reconnect and resume do not
clear them or resend the input/control. New input and prompt responses remain blocked. A fresh
snapshot still permits an explicit generation-fenced interrupt. If its acknowledgement is lost,
it adds another record and cannot replace the original submission or approval. `acknowledgeUncertain(id)` only clears the named record after a fresh attached snapshot
shows no running or unresolved pending work. A future UI must present the exact uncertain action
and obtain an explicit decision before calling it. Acknowledging one record cannot clear another
record's fence. It sends nothing and never replays the old operation. Spent approval IDs remain spent. Server-side unknown admissions cannot be resolved by
this stage. The marker is memory-only, not a crash-durable intent journal; replacement transport
objects cannot prove outcomes from a previous process or object.

## Bounds and ownership

Each socket has an eight-second upgrade/readiness and RPC deadline, a 256 KiB frame limit, at most
128 JSON lines per message, at most four pending calls, and no message compression. One event
consumer has at most 128 queued events and 1 MiB of queued projected data. Overflow closes the
socket instead of silently losing controls. Prompt and completed-admission deduplication each
retain at most 256 IDs per transport; reaching the limit requires an explicit new transport.
Snapshots have at most 128 pending admissions and 32 prompts. Input is at most 16,384 characters
and 32 KiB. A 15-second application heartbeat closes a socket after 45 seconds without inbound
traffic. No timer reconnects it. Close cancels readers/requests, clears buffers and timers, and
removes the transport from its account owner.

## Verification and limits

Run `node --import tsx scripts/hermes-gateway-chat-e2e.ts`. Its report is
`.openbot-build/hermes-gateway-chat-e2e/report.json`. Nineteen groups drive the real native auth,
HTTP, socket, canonical session and control adapters against a credential-free synthetic gateway.
They cover same-ID account/profile isolation, exact approvals and clarification, interrupt,
coalesced/duplicate/racing frames, payload-only generations, lost turn/approval acknowledgements,
explicit reconnect without replay, substituted identities, unsupported capabilities, cancelled
ticket mint, pending mutation/read cancellation, slow-consumer overflow, malformed/binary frames,
unsupported edits, account-specific authentication refusal and owner/expired-token closure. A separate synthetic TLS child trusts only its
temporary fixture CA, then proves that the persistent WSS adapter refuses a replacement untrusted
certificate before the ticket header reaches the server. Temporary keys are removed.

The five review groups add real local metadata/control variants, partial/mixed/foreign controls,
raw/JSON/URL credentials split across chunks, redacted choice labels, bounded ambiguous carry,
capable and unsupported viewers of one shared prompt, and lost-submit/lost-interrupt chains.
All five defects were reproduced on `854b32e78` before their fixes. Safe reproduction results are
under `.openbot-build/hermes-gateway-chat-review/before-report.json`. The two protected logging
test files cover the unchanged text redactor and new streaming primitive, including every split
point, overlapping match chains, final partial prefixes, reset and buffer overflow.

The foundation and setup fixture suites remain required. The CI provider-fakes lane runs this
script and uploads its report when the normal workflow runs. That workflow targets `main`; it
does not automatically test this stacked PR base. No full manual workflow was dispatched.

These fixtures model the pinned source; they do not execute a live Python gateway. The heartbeat
and RPC timeout durations, future-time token expiry, server permission outages, real proxy
deployments and cross-process restart recovery are not exercised by this suite. No real gateway,
credentials, live app, OS/network setting, production build or existing user data was used.

There is no end-user remote chat yet. Session creation/listing, history/imports, event backfill,
queued turn controls, unknown-admission resolution, slash/tool displays, attachments, batch/edit/
sudo/setup prompts, UI approval decisions, durable uncertainty, native refresh, OAuth, SSH,
auto-connect, saved credentials and remote revocation need separate stages.
