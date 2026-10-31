# Authenticated migration destination verification: proposed design

Status: **Docker publisher policy approved; connected verification unavailable**. The owner approved
explicitly paired servers and exact verified builds, with mismatches blocked. The first publisher
policy is Docker to Docker using `jorge123255/openbotv`'s release workflow and an explicitly approved
release tag. The actual [policy-status panel](migration-docker-trust-policy.md) remains blocked. The
[synthetic verifier](synthetic-destination-verification.md) tests a candidate admission policy only.
This document follows [migration preparation](migration-preparation.md) and
[offline assessment](migration-assessment.md). A read-only local policy IPC endpoint exists; no
connected verification route, transport, credential, pairing or certificate exception is added.
Export, restore and activation remain unavailable. All current declarations remain unauthenticated.

The next production slice must show which selected destination answered, which build it reported,
and when that observation expires. A signed response can authenticate a host assertion. It cannot
prove that a compromised host runs the claimed binary, confines an executor, owns a storage root,
or can restore the source. Do not label that response as complete destination verification.

## Current source evidence

The inspection used fork main `161f0a67`, preparation `943d21da`, and assessment `af1fb6b2`.
Drafts #62 and #63 supply the local plan and offline report; they do not connect to a destination.

| Existing component | Confirmed behavior | Gap for this slice |
| --- | --- | --- |
| [RemoteServerClient.verifyIdentity](../../src/main/remote-server-client.ts) | Checks server ID, expected fingerprint, fresh challenge and Ed25519 signature before the HTTPS join uses credentials. | The proof does not sign a migration plan, capability response or build identity. |
| [TeamStore.getIdentityProof](../../src/main/team-store.ts) | Signs the challenge bytes with the existing host key. | Do not reinterpret that released proof as a signature over other fields. |
| [Host-key handover](../../packages/team-client/src/host-key-handover.ts) | Follows a chain signed by both old and new keys from an already trusted fingerprint. | It does not establish trust in the first key or authorize migration. |
| [Remote directory](../../packages/team-client/src/remote-directory.ts) | Can accept an advertised host key on first connection when no pin exists. | A saved pin alone is not proof of independent owner verification. Preserve its trust provenance and require an explicit migration trust decision. |
| [Remote peer](../../packages/team-client/src/remote-peer.ts) | Authenticates the host with a transcript that binds host/session/ticket, nonces and DTLS fingerprints. | No migration receipt or exact-build observation is implemented. Cancelling a client wait does not undo a sent request. |
| [HTTP adapter](../../src/main/remote-server-http.ts) | Uses abortable fetch with a default 15-second transport deadline. | It has no migration-specific redirect refusal, endpoint pin or bounded body read; its fetch deadline does not cover a separate unbounded JSON body read. |
| [Contracts rules](../../packages/contracts/AGENTS.md) | Application version is diagnostic metadata. New optional behavior needs a new capability; protocols 7 and 8 have full capability lists. | Do not change a released route/codec or use SemVer as protocol or exact-build identity. |

No exact-build migration manifest/provider was found in the inspected main connection/identity code,
Electron build configuration or build scripts. This is a source-audit limit, not proof that no
unrelated artifact digest exists elsewhere. Runtime/recipe digests for other components do not identify
the complete running migration destination.

## First trusted destination

The owner selected explicitly paired verified servers for the first version, with standalone pairing
to follow. The full-house request permits local, Docker and user-chosen servers. It does not authorize
a new unverified first-key bootstrap. The options below record the design alternatives.

| Option | User workflow | Benefit and constraint |
| --- | --- | --- |
| A: existing paired HTTPS host first | Select a paired HTTPS host with approved trust provenance or independent fingerprint confirmation. Require source-owner and destination-owner/admin authority. | Reuses an explicitly approved pin. Excludes WebRTC-only, HTTP-only and never-paired hosts initially; separate adapters can follow. |
| B: standalone console pairing | Open the destination console and compare its public-key fingerprint through a separate trusted channel. Approve a short-lived, read-only pairing on both ends. | Fits account-independent self-hosting. Needs a reviewed bootstrap, mutual authentication, expiry/revocation and certificate-provisioning workflow. No trust on first use or fingerprint from the same untrusted response. |
| C: operator-managed PKI | Provision a trusted CA and client/server certificates outside the migration flow. | Fits managed servers. Requires certificate issuance, renewal, revocation and private-key lifecycle policy. This slice must not configure those credentials. |

The approved scope starts with explicitly trusted paired servers. The proposed first live transport
is A's HTTPS adapter; B remains a separate adapter so standalone hosting remains possible. Do not silently
add B or C as fallback when A fails. Do not transfer a source host private key to make another host
appear paired. The destination keeps its own identity; source identities/history are transfer data
for a later, separately verified step.

Option A must identify how the saved pin became trusted. A key learned only from the account
directory needs an explicit owner trust decision through the chosen policy; do not treat storage as
independent verification. The current stored entry does not itself supply an approved provenance
record; the next implementation must add or obtain it. Require local source-owner authorization and
current destination-owner/admin authority. Neither account membership nor this informational check
grants consent to move secrets.
Whether a later cutover preserves the source logical host ID through handover or relinks clients to
the destination identity is a separate future decision; this receipt must not decide it.

## Exact build

The first admitted artifact scope is the verified OCI index-to-platform-manifest/config chain for
the approved fork release. Desktop archives, installed bundles and local/development builds are
outside this first Docker policy. They need a separate trust path; the alternatives below do not
enable them.

The approved rule requires the exact same verified build and blocks a mismatch. A live adapter still
needs a defined trusted artifact: installed desktop/server package, container
image, or an operator-approved manifest for a development checkout. Define the complete executable
and runtime scope, digest format, publisher trust and update policy before reporting an exact match.
Version, Git commit, an image tag or an arbitrary digest supplied by the destination is insufficient.

The proposed first policy is a manifest with fixed canonical encoding and an immutable digest, bound
to the selected artifact type, platform, architecture and migration protocol. Verify publisher evidence
against an owner-approved trust root. The running service must expose the manifest it checked at
startup; an update or restart invalidates the prior runtime instance. A signed host response binds the
claimed digest to that response, but does not independently attest executing bytes. State this limit
in the UI. If trusted manifest evidence or runtime binding is unavailable, the result is
**build unverified**. Do not enable migration or substitute a matching version string.

No production build, signing-key access or packaging change is authorized by this design document.

## Proposed production ownership

Add a separate main-process verification service beside the preparation/assessment services. Use
Effect 4, typed fixed errors, injected clocks/entropy/transport/trust/build providers and IO-free
constructors. Main selects a destination by stored server ID. Renderer data must not supply a URL,
fingerprint override, CA exception, authorization header, local path, command or socket.

For option A, add a frozen, optional `migration-destination-v1` contract on a protocol-9-only
capability. Review the final capability name before release. The host route must require current
owner/admin authority, use a migration-specific domain separator and perform only bounded metadata
reads. Do not reuse the old challenge-only proof for a new signed payload. Keep existing Team APIs,
client adapters and their permission rules unchanged.

The first endpoint issues no reservation, session transfer, upload permission, schedule change or
execution command. Its authorization is read-only and separate from any future cutover grant.
Do not read real credentials or create durable ongoing access in the synthetic implementation.
The synthetic verifier imports public RFC vectors only; the policy-status service uses no keys.
Future TLS fixtures may generate owned temporary
credentials, with cleanup, as part of their separately reviewed tests. A later live adapter
may use existing authorized connection state only within the approved trust model.

## Plan and response binding

Create an expiring verification attempt under a specific prepared-plan UUID and revision and an exact
offline-assessment ID, revision and digest. Keep the existing preparation/assessment journal formats
unchanged. The attempt is not a bearer credential. Proposed limits, to be fixed in the new contract,
are one active attempt per plan, a 10-second total operation deadline, a 60-second receipt lifetime,
and a 32-KiB response limit. Do not renew a receipt merely by reopening the page.

The canonical signed response must bind all of these values:

- Protocol/domain version; source and destination identities; request ID; fresh random challenge.
- Parent plan UUID/revision and exact assessment identity/digest; attempt expiry and selected origin.
- Destination host-key fingerprint, distinct installation identity and runtime-instance identity.
- Exact build-manifest identity/digest, supported protocol and full bounded capability observation.
- Platform, architecture, source-schema support, executor kind and storage-root identifiers.
- What was observed, what remains unknown, and fixed issue/expiry times.

Authenticate the source request and the complete destination response through the selected pairing
model. Use existing vetted Ed25519 implementations, with a new canonical signed statement and strict
limits. Do not create a new cryptographic primitive or trust a key contained only in the response.
Unknown fields, duplicate JSON keys, invalid encodings, duplicate capabilities or inconsistent binding
must refuse. Specify canonical bytes before releasing codecs; do not sign arbitrary reserialized JSON.

Validate the prepared binding and selected host/key/build before sending, after receiving, and when
showing evidence. Use a local monotonic deadline for an in-flight request plus bounded wall-clock
checks for signed receipt expiry. Refuse responses with a changed plan/report, wrong request/nonce,
unexpected origin/host/key/installation/build/runtime, expired or future issue time, excessive lifetime,
or revoked authority. Key handover or a build change starts a new attempt; it must not rewrite a saved
observation. Consume the challenge once, and refuse replay. A restart discards pending attempts and
requires fresh verification; a retained receipt is history until a fresh check succeeds.

## Transport and network boundary

Implement a migration-specific adapter; do not change the generic transport used by released clients.
The first proposed live eligibility is an approved paired HTTPS host only. Refuse HTTP-only and
WebRTC-only destinations. A separate authenticated WebRTC-channel adapter needs its own binding and
acceptance design; an SDP address is not an HTTPS origin. This initial limit does not remove existing
hosting or connection options.
Require HTTPS with a valid certificate chain and hostname, using only the approved trust store. Reject
all redirects, HTTP downgrade, URL credentials, fragments, alternate origins and certificate errors.
Never disable certificate checks or accept an untrusted self-signed certificate. A custom-CA workflow
needs its own approved option; it cannot be a retry fallback.

Main derives the exact origin and fixed path from the selected paired host. Review explicit policy
for LAN, loopback and public hosts, DNS rebinding and proxies before a live adapter exists. Reject
metadata-service, multicast and unspecified targets; bind the approved resolution to the connection
while retaining hostname/SNI verification. Do not infer permission to scan a subnet or probe a new
address. No renderer URL or endpoint returned by a response may trigger another request.

Bound headers, response bytes, JSON depth, collections and decompressed size. Keep one total deadline
through connection, TLS, headers, body read and signature/contract validation. Abort and dispose the
owned transport on cancellation or expiry; reject late responses without changing state. Do not
automatically retry an uncertain attempt or treat client cancellation as host rollback.

## Evidence and user workflow

After the trust decisions, extend the actual Server settings flow: prepare, assess declarations,
select an eligible paired destination, request verification, then inspect the bounded evidence.
Show **Declaration — unauthenticated** for the existing form and **Authenticated host response** only
after the new checks pass. Show the selected host fingerprint, artifact digest, observation time and
expiry. Keep host assertion, independent build evidence and executor/storage proof separate.

A host-reported container/VM label does not prove isolation. Report filesystem ownership, persistence,
free space, external mappings and source-schema support as unknown unless an approved adapter actually
checks them. Do not mount Docker/libvirt sockets or increase agent privileges. Unavailable capability,
authority loss, expiry, plan change, restart and response loss need clear retry/new-attempt states.
Use fixed localized errors; do not expose response bodies, tokens, paths or raw TLS/crypto causes.

Preserve #63's `destinationVerified:false`, `inventoryComplete:false`, all six blockers and disabled
operations. New evidence is a separate additive contract. It cannot promote an offline declaration,
reserve the target or authorize export, restore, activation or a second source writer.

## Production implementation after the synthetic slice

1. Add a trusted artifact/build-identity provider and a strict optional contract/codec. Freeze its
   canonical signed bytes, bounds and vectors. Use synthetic keys and manifests only during development.
2. Add actual host route/service and main verifier behind injected trust and transport ports. Exercise
   them through an owned loopback HTTPS fixture with generated credentials; do not connect to a saved
   real server or read account/keychain state. Use a fixture-only CA trust configuration. Production
   code has no insecure-TLS or arbitrary-URL test switch.
3. Add typed trusted IPC, independent preload decoding, functional preview and actual settings UI.
   Keep the real-network adapter unavailable until endpoint/DNS/proxy policy and trust decisions are
   implemented and reviewed. A fixture result must never appear as a verified saved destination.
4. Only after these checks, review a live adapter as a separate change. No production deployment,
   account operation, credential export or cutover is part of this slice.

Minimum acceptance uses the real route, verifier, IPC and UI with generated source/destination profiles:
successful paired challenge; wrong key/host/build/installation/runtime; expired/future/replayed/late
response; cancelled/replaced plan or changed assessment; key rotation and restart; absent capability
and lost authority; redirects of every status; invalid chain, wrong hostname, expired certificate and
HTTP downgrade; slow headers/body, oversized/compressed/malformed response; cancellation and resource
cleanup; DNS/endpoint-policy refusal before request; fixed-error redaction; no live/user file or real
credential-store reads, routine execution or migration actions. Assert TLS refusals and redirect targets receive no credential
or follow-up request. Keep existing released-client and offline-assessment behavior intact.

## Current implementation limit

The owner approved the Docker-to-Docker fork publisher policy and exact same verified builds. The synthetic
slice verifies public fixture signatures, supplied artifact bytes and exact platform/architecture/
runtime/artifact identity; it does not measure a real installation. No production endpoint, live
transport, pairing record, build provider or application verifier is available. The actual app remains
offline-only for migration assessment and policy status. A later live slice must implement the artifact/transport and
trust-provenance requirements above without substituting version labels for exact build identity.
