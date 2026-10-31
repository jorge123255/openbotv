# Synthetic credential portability lab

This development prototype tests encrypted synthetic records in memory. It is not a credential
exporter, OS-store adapter, migration command or supported application restore path. It reads no
real credential store, keychain, provider account, browser profile or user data. It starts no app,
provider or network connection. The broader migration requirements remain in
[draft PR #53](https://github.com/jorge123255/openbotv/pull/53).

Run `node --import tsx scripts/credential-portability-e2e.ts`. The script accepts no arguments,
paths, keys or credentials. It writes its fixed-result report to
`.openbot-build/credential-portability-e2e/report.json`. It writes no plaintext credential file.

## What this stage implements

[lab.ts](../../scripts/credential-portability-lab/lab.ts) creates three independent ephemeral,
nonextractable keys: source wrapping, transfer protection and destination wrapping. These model
separate protection domains; none is an actual OS key. The fixture has two portable secret records,
two records that require reauthentication and one unavailable hardware-key record. The latter
three contain association metadata and reasons, not pretend exported secrets.

Source export, destination staging and candidate discard require separate synthetic approval
markers. These markers exercise refusal behavior. They do not authenticate a person or provide
real consent. Source ciphertext is opened, authenticated records are sealed for transfer, and the
destination opens and reseals them with its own fixture key. It opens that candidate again and
compares the complete bytes and associations before publishing the candidate in memory.

The lab also compares portable values against its private generated source before staging. This
source oracle exists only because source and destination are one synthetic process. It rejects a
correctly encrypted envelope with changed fixture values. It does not establish a real destination
trust protocol: a real receiver needs independently authenticated source approval and key delivery.

[envelope.ts](../../scripts/credential-portability-lab/envelope.ts) uses the existing `jose` 6.2.13
dependency, with no dependency or lockfile change. JWE Compact Serialization uses `alg: "dir"`
and `enc: "A256GCM"`; the library generates the IV. Each purpose has an exact protected header:
`typ: "openbot-synthetic-credentials-{source|transfer|destination}+jwe"` and
`cty: "application/octet-stream"`. Algorithms, compression, extra headers and key-discovery fields
are not negotiated. Accepted wire data is canonical base64url, at most 32 KiB, with a 12-byte IV,
a 16-byte tag and at most 16 KiB of plaintext. Decryption uses exact algorithm allowlists and
disables decompression. See [jose](https://github.com/panva/jose),
[RFC 7516](https://www.rfc-editor.org/rfc/rfc7516.html) and
[RFC 7518](https://www.rfc-editor.org/rfc/rfc7518.html).

[model.ts](../../scripts/credential-portability-lab/model.ts) validates authenticated plaintext
against a strict versioned schema. It rejects invalid UTF-8, noncanonical JSON, duplicate keys,
unknown fields/kinds/versions, duplicate IDs and invalid account/agent references. The independently
held expected context binds the exact source, destination, transfer, snapshot digest, destination
baseline digest and credential association set. Authenticated but wrong records are still refused.
The format permits at most four accounts, four agents and eight credentials; each credential names
one to four agents. This reduced fixture format is not an adapter for every production store.

Staging uses an in-memory revision check before work and again immediately before publication.
Only one competing candidate can commit at a revision. A consumed transfer ID remains spent after
candidate discard for the life of that lab object. This is single-process modeling, not durable
replay protection or a distributed transaction. Restart/key loss has no recovery path. Source and
destination baseline ciphertext stay unchanged; candidate publication is separate from activation.
Cancellation before publication and injected unwrap/rewrap/verification failures leave no partial
candidate and preserve the prior modeled state.
`activate()` always returns `ACTIVATION_UNAVAILABLE`, including after a verified candidate.

## Credential classification for future adapters

Byte preservation, destination decryption and remote login usability are different checks. The
following table is a source-code inventory, not proof that any real credential can be migrated.

| Class and code evidence | Required handling |
| --- | --- |
| API keys: `src/main/provider-credential-store.ts`, `custom-provider-store.ts`, `custom-agent-store.ts`, `voice-api-key-store.ts` | Secret bytes can be copied when export is permitted, but current OS wrapping needs approved source unwrap and destination rewrap. Keep provider/config IDs, every secret header and environment-name/value association. |
| Host/account sessions: `src/main/central-auth-manager.ts`, `remote-server-stored-shape.ts`, `local-servers/local-server-registry.ts` | Preserve host/account/child IDs, sealed owner passwords, pinned keys and token associations together. Copied tokens remain subject to server-side expiry, revocation and device rules. |
| Team identity: `src/main/team-store.ts` | Preserve PEM signing keys, member verifiers, session/invite hashes and pending rotation as one identity set. These exportable bytes must be protected even where the source file does not use OS wrapping. Never activate a competing identity copy. |
| Grok Bot: `src/backend/grok-bot/grok-bot-account.ts` | Keep access/refresh tokens, gateway URL/token/headers and optional VNC credentials together. Destination gateway/session validity is not established by successful decryption. |
| MCP: `src/main/mcp-oauth-store.ts`, `mcp-oauth-proxy-store.ts`, `src/backend/mcp-oauth-provider.ts` | Keep resource URL, issuer, app/client registration, scopes, complete token set, obtained/expiry metadata, discovery/lost state and proxy port/secret. Changed callback/client bindings can require sign-in. |
| GitHub/messaging: `src/main/github-connector-store.ts`, `messaging-credential-store.ts` | Preserve refresh metadata, GitHub account identity/proxy secret, and each messaging connection ID with its full credential record. Imports must not refresh, subscribe or post. |
| Vault/connectors: `src/main/vault-store.ts`, `onepassword-connector-store.ts`, `bitwarden-connector-store.ts` | Preserve item/account IDs and complete secret records through reviewed adapters. Stored service/API tokens and passwords differ from memory-only unlocked sessions. Do not unlock a real vault during rehearsal. |
| Ingress/runtime secrets: `src/main/ingress-queue-key.ts`, `remote-desktop-secret-store.ts`, `routine-feed-server.ts` | Preserve exact keys and their paired public keys, ports and references. Unreadable source material is a blocker; do not regenerate it as migration recovery. |
| Push registrations: `src/main/push-notification-store.ts` | Push tokens and sealing secrets are sensitive even in an ordinary private JSON file. Preserve member/session associations inside the encrypted payload; remote validity remains untested. |
| CLI accounts: `src/backend/agent/provider-account-store.ts`, `src/backend/provider-drivers.ts`, `process-confinement.ts` | Inventory default homes and additional account IDs, configured paths and histories. File-based token bytes may be copyable; provider/version-specific or OS-backed storage needs a tested adapter. A readable folder is not proof of a usable login. |
| macOS CLI Keychain: Claude in `src/backend/provider-drivers.ts`; Cursor in `src/backend/agent/cursor-deep-login.ts` | Use only supported per-account export. Never copy the entire OS keychain. Unsupported export, changed path binding or device binding requires reauthentication or an unavailable status. |
| Browser/OS/hardware credentials | Inventory separately; there is no generic export adapter in this lab. Cookie/profile bytes do not prove reusable authentication. Nonexportable device/hardware keys cannot be copied; retain associations and report the exact unresolved item. |
| Container keyring: `scripts/hosting/openbot-container` | A future transfer must protect the Linux keyring and unlock password together in an encrypted recovery unit. Existing ordinary backup compression is not encryption. Same-instance recovery does not prove cross-OS portability; actual unlock and destination rewrap need separate checks. |
| Logical sessions: `src/main/remote-session-cache.ts` | A logical session ID is private account/host metadata, not an authentication credential. Preserve its association without treating it as a usable login token. |

Keep original agent, account, credential, connection and item IDs, with all supported record fields.
Reauthentication must attach to the existing account/history; it must not create a replacement agent.
Unknown formats, missing roots, unreadable ciphertext or unresolved mappings block completion.
Do not replace such records with empty credentials. A bearer token can expire or be revoked even
when its bytes survive every offline check. OS/device/hardware/provider rules can require sign-in.

## Required production sequence, not implemented here

1. Inventory the exact source, destination, categories and associations. Obtain separate explicit
   approval for source export and destination import, with the selected categories visible. A saved
   host-tool approval or an ordinary backup is not credential-transfer authorization.
2. Stop all writers and credential refreshers and capture a consistent snapshot with a verified
   backup. An approved source adapter unwraps only selected records into privileged memory. Keep
   original blobs on failure; suppress fallback key generation before ordinary startup.
3. Transfer through a reviewed authenticated encrypted format with keys delivered separately through
   an authenticated mechanism. Bind private inventory, identities, paths, hashes, versions and
   source/destination context inside the protected payload. Keep public headers minimal.
4. After destination approval, authenticate and validate everything before changing destination
   state. Use the destination OS cipher, stage without overwrite, reopen and verify the complete
   candidate. Keep providers, connectors, routines, queues and host publishing inactive. Refuse
   missing protection, wrong keys, tampering, unknown versions and unavailable adapters.
5. Resolve each required reauthentication item under its own approved action. Keep the distinction
   between bytes preserved, destination wrapping verified and provider usability checked. A future
   live check must not run as part of this offline lab.
6. Obtain cutover approval, durably fence every source supervisor/identity copy, recheck the approved
   snapshot and target, then admit the destination writer. Do not infer fencing from encryption or
   a stopped backup. Keep local hosting and user-chosen server placement available.
7. Rollback first stops and fences the destination. Capture new work and reconcile changed token
   generations before source resume. Restoring an old refresh-token file cannot undo provider-side
   rotation or revocation. Do not revoke source credentials automatically during rehearsal/rollback;
   revocation can affect both copies and requires a separate approved action.

## Evidence and remaining limits

The E2E drives the real fixture service and `jose`: it checks round trips, fresh IVs, approval and
adapter refusals, wrong keys, tampering, malformed framing/headers, strict payload/context checks,
failed staging, cancellation, competing revisions, consumed-ID retention, key loss and fixed-code
diagnostics. Generated secret canaries must not appear in the report or public failures. The result
distinguishes two preserved/rewrapped synthetic secrets, two reauthentication items and one
unavailable item. Remote usability is always `not-tested`; incomplete migration never becomes success.

Shared-key JWE integrity does not prove source identity or human approval: any holder of the transfer
key can forge a valid envelope. Real key delivery, source authentication, persistent key recovery,
durable replay records, OS adapters, provider validity, full-app offline startup and one-writer fencing
remain unimplemented. The lab does not test browser/device portability or every production schema.
It clears owned byte buffers on release, but JavaScript strings/copies and garbage collection prevent
a guarantee of complete secret zeroization. Synthetic plaintext also exists in fixture memory.

The report keeps `realCredentialStoresRead`, `realCredentialsExported`, `realCredentialsVerified`,
`productionImportAvailable`, `keyDistributionVerified`, `sourceAuthenticationVerified`,
`durableReplayImplemented`, `oneWriterFenceImplemented`, `fullAppStartupTested` and
`fullMigrationComplete` false. Passing this lab does not enable real export, import or activation.
