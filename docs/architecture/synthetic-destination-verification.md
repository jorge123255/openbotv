# Synthetic destination verification

The owner approved a first version with an explicitly paired verified server and the exact same
verified build on both ends. A mismatch must block the check. This slice tests that policy through
the actual preparation/assessment services and a test-only verifier. It adds no connected destination
workflow. See the [production design](migration-destination-verification.md) for the remaining work.

## Scope and ownership

[SyntheticMigrationDestinationVerifier](../../src/main/synthetic-migration-destination-verifier.ts)
is not registered in application services, IPC, preload, the renderer or a Team route. It has no
filesystem, HTTP, DNS, TLS, credential-store, process-launch or persistent-grant adapter. Its only
caller is the [generated acceptance script](../../scripts/synthetic-migration-destination-verification-e2e.ts).
Constructors perform no IO. Effect owns each attempt, deadline and cancellation.

The source context, owner/admin approval, independently confirmed pin, approved publisher key,
installation/runtime identities and TLS observations are injected fixture facts. The source request
is not cryptographically authenticated by this slice. The destination signature is checked with
Ed25519, but the fixture signer uses fixed, publicly known
[RFC 8032 test-vector material](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1). That material
cannot establish real trust and must never become a production credential. No key pair, account,
credential, certificate or ongoing authorization is created or persisted by this slice.

The endpoint is an in-memory fixture function, not a server. TLS/redirect cases verify admission
policy over fixture observations; they do not test a real handshake, DNS, proxy policy or an HTTP
redirect implementation. No saved host, account, keychain or real destination is read or contacted.

## Exact artifact identity

A fixed, canonical, publisher-signed manifest identifies supplied fixture bytes. It contains a
versioned synthetic format, synthetic artifact kind, platform, architecture, runtime, byte length
and SHA-256. The verifier decodes the supplied bytes, computes their length and digest, and checks
the manifest signature against the source-side approved publisher key. It performs this for both
source and destination before comparing the complete canonical manifest identity.

Only `synthetic-package` and `synthetic-image` are admitted. Neither represents an installed tree,
OCI image index/tag, running image, packaged executable or independently attested process. There is
no production manifest provider or publisher trust store. Nonsensical fixture runtime/platform
combinations are not evidence of runtime eligibility even if they have matching signatures.

Different platform, architecture, runtime or artifact kind refuses as `platform-incompatible`.
Otherwise any manifest/byte-identity mismatch refuses as `build-mismatch`; invalid publisher evidence,
bytes or canonical encoding refuses as `build-unverified`. App versions, commit labels and image tags
are not inputs to this identity rule. A Mac-to-Linux or x64-to-arm64 move cannot pass by sharing a
version label, by using a multi-platform image tag, or by claiming an equivalent build. A later
cross-platform migration policy requires a separate design; this rule remains exact.

Supplied-byte verification proves which fixture bytes matched a signature. It does not prove the
bytes loaded by a source or destination process, host integrity, storage ownership, one writer,
executor isolation, credential portability or source quiescence.

## Attempt admission

The selected pairing must bind an independently confirmed pin to the source host, distinct
destination host, exact HTTPS origin and installation/runtime identities. Directory-only/unapproved
pins, absent source-owner or destination-owner/admin approval, invalid Ed25519 keys, and unapproved
publisher evidence refuse. The existing host-fingerprint function is reused; no trust record is read
or written. The fixture authority does not grant secret migration permission.

The context binds the prepared plan UUID/revision and current assessment UUID/revision, plan link
and digest. A detached canonical snapshot is made before the endpoint is called. The endpoint sees
a frozen request with fresh 32-byte challenge and request UUID, all plan/report/destination bindings,
source manifest identity, publisher fingerprint and a 60-second expiry. Its complete response is
signed with a distinct purpose. Source-side pins and expected values never come from the response.

The verifier rejects wrong status, origin, redirect or TLS state before body parsing. It bounds the
response to 32 KiB and each synthetic artifact to 4 KiB. Strict schemas, fatal UTF-8 decoding and exact
canonical re-encoding reject duplicate/unknown JSON fields, ambiguous encodings and noncanonical
base64url. Capabilities have closed bounds, unique sorted values and a required synthetic capability.

After the endpoint returns, the verifier rereads the authoritative fixture context. Any plan,
assessment, key, authority, build, runtime or trust change refuses. A final monotonic 10-second
deadline and wall-clock issue/expiry check reject stale, future, late and replayed responses.
One attempt can run per verifier instance. All exits release that slot; there are at most 32 attempts
per instance. Restart retains neither pending work nor receipts. Cancellation has no remote rollback
meaning; the fixture operation has no mutation to undo.

Success is always `scope: synthetic-only`, `artifactMatch: exact-synthetic-artifact`, with
`runtimeAttested:false`, `destinationVerified:false`, `inventoryComplete:false`, all six preparation
blockers and disabled export/restore/activation. `authenticatedHostResponse:true` means only that the
fixture response signature matched the fixture pin. No persisted result or production grant exists.

## Verification and next production step

```sh
node --import tsx scripts/synthetic-migration-destination-verification-e2e.ts
```

The acceptance script generates its own database, preparation plan and assessment, then derives
their real IDs/revisions and report digest. It uses fixed public test-vector signing material,
owned fixture data and in-memory endpoint observations. Evidence is redacted at
`.openbot-build/synthetic-migration-destination-verification-e2e/report.json`. The narrow command and
report are selected with the existing offline assessment CI lane. This feature-branch stack does
not automatically trigger CI's main/pull-request-target-main filters; local evidence is not a green-CI claim.

Before a connected release, implement source authentication and explicit trust provenance, a real
publisher/artifact provider with startup/runtime binding, an authenticated host route, and a dedicated
bounded HTTPS adapter with actual certificate/hostname/redirect and endpoint/DNS/proxy enforcement.
Then test the route, adapter, trusted IPC, independent preload decoder and actual settings UI together
with owned synthetic HTTPS endpoints. No such production component is supplied by this test-only
slice. Existing declarations in Server settings remain unauthenticated and all migration actions
remain unavailable.
