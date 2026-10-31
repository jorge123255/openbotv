# Grok Bot cached usage diagnostic

This optional diagnostic checks whether the current sandbox exposes existing run usage and nonce metadata. It does not reduce tokens, compact context, report token counts, or estimate cost.

## Opt in

Use a build with this change. The owner chooses when to launch it with `--enable-grok-bot-usage-diagnostic`. This flag only adds **View → Run read-only Grok Bot usage check**. It does not run the check at startup. Select that native menu item to run one check. The item is absent without the flag. There is no renderer IPC or Team API entry.

The check uses only a gateway snapshot that normal account activity already loaded in this process. It does not read the account file or call the credential cipher. A cold cache, signed-out account, or missing gateway stops the check. It does not open Settings, sign in, ask for a new grant, refresh credentials, or call `EnsureSandBox` to make a session available. Ordinary app activity is separate from this diagnostic.

Saving or refreshing account data, sign-out, an unsuccessful account load, or service disposal invalidates the snapshot. Sign-in, sign-out, and disposal cancel a running check. Only one check can run at a time.

## Requests and limits

Only these four fixed read operations are permitted, with no retries or redirects:

| Endpoint | Bound |
| --- | --- |
| `POST /api/listAgents` | Inspect at most 20 returned rows and select one agent |
| `POST /api/getAgentRunHistory` | Request and inspect at most 10 runs for that agent |
| `POST /api/getAgentTranscriptTail` | Request and inspect at most 20 entries to find an existing user nonce |
| `POST /api/promptAcceptanceStatus` | Read that existing nonce in the `host` account slot |

Later reads are skipped when their input is absent. Any HTTP error, redirect, malformed response, cancellation, or body limit stops the check. No endpoint is called twice. Each response is limited to 128 KiB, each request to 1.5 seconds, and the whole check to 6 seconds.

The saved origin must be HTTPS on `cursorvm.com` or a subdomain, without user information, a custom port, query, or fragment. Only the cached bearer and `x-anyrun-network-token` header are used. Cookies and other saved headers are omitted. There is no arbitrary URL, endpoint, prompt, or settings input.

## Output

The local log scope is `grok-bot-cached-usage-diagnostic`. It records one summary with fixed status labels, HTTP status codes, the bounded number of runs inspected, usage-field presence booleans, and structural correlation checks.

It does not log or export gateway URLs, headers, credentials, agent IDs, nonces, echo IDs, provider request IDs, raw usage values, transcript contents, response bodies, unknown fields, or private error causes. No raw response is written to a file or sent to the renderer.

`nonceEchoMatched` checks returned nonce/agent/echo equality. `runNonceExactMatch` is unknown unless a run explicitly returns a nonce; when present, it checks string equality only. Neither field proves that all provider requests or billed tokens belong to one OpenBot turn. Do not join records by timing, list order, or transcript position.

No known read-only compaction capability is probed. The internal BotAI summarizer and daily-budget settings are not a supported compaction contract. Unsupported endpoints and missing fields remain unknown. A successful HTTP response alone does not establish reliable usage accounting.

## Verification

The focused E2E uses temporary synthetic account files and a loopback service. It tests the opt-in and cold-cache stops, no-account/no-session behavior, no credential decryption, cache invalidation, origin/header restrictions, endpoint/count bounds, auth failures, redirects, body limits, malformed responses, timeouts, cancellation, and safe output. Protected main-process tests check actual log output and cancellation on sign-out. No live app or provider is needed.
