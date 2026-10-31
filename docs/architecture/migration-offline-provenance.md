# Isolated Sigstore verification

This stage checks real Sigstore signatures with public upstream test vectors. It does not admit a
release or a destination. The application service graph, IPC and Move/Restore controls do not call
the verifier. The [approved Docker policy](migration-docker-trust-policy.md) stays blocked.

`src/main/migration-offline-provenance.ts` owns this isolated adapter. Its only trusted-root pin is
the exact public fixture root hash recorded in `scripts/fixtures/migration-provenance/SOURCE.json`.
The root contains historical and mock test material. It cannot establish production trust. There
is no caller-selected root pin, production root inventory, root refresh or trust override.

The adapter calls the installed SDK to check the certificate chain, certificate transparency,
Rekor inclusion proof and checkpoint, timestamp and signature. All three SDK thresholds are one.
It then compares the certificate issuer and SAN as exact strings. A caller's expected signer is
only a test constraint; it cannot approve a release. SDK SAN string policies use regular expressions,
so this adapter does not pass a raw identity string as an SDK policy.

Verification covers the authenticated signature and evidence, not every outer JSON field. For
example, Merkle inclusion uses the signed checkpoint's root; changing the separate unsigned proof
root field is not a signature forgery. No raw bundle metadata is returned as a trusted release fact.

Message signatures bind the exact supplied artifact bytes. DSSE verifies the envelope payload only
and refuses an external artifact argument. Its result has `artifactBound: false`. In particular,
the public `text/plain` DSSE fixture is not SLSA provenance or a signed OCI subject. No JSON payload
is treated as an in-toto statement by this stage. Every result has `productionTrusted`,
`releaseApproved`, `runtimeVerified`, `destinationVerified` and all migration operations false.
No result is an authorization handle.

Input is copied from non-shared byte arrays. Root and bundle inputs are limited to 256 KiB,
artifact inputs to 16 MiB, JSON depth to 24 and each collection to 64 members. JSON must equal its
minified `JSON.stringify` encoding, with zero or one terminal LF. This rejects duplicate keys,
extra whitespace, BOMs and alternate encodings before the SDK. It is an isolated adapter rule,
not a change to the Sigstore wire format. Bundle JSON must also survive the pinned SDK's
protobuf decode/encode without a change. This rejects competing one-of fields, unknown fields,
noncanonical base64 and explicit default fields omitted by that encoder. The message fixture
omits two unsigned default fields for this reason. Root hashes cover exact admitted bytes. Signed payload,
certificate, checkpoint and signature bytes are never rewritten.

Failures expose a fixed typed code. SDK messages, certificates, payloads and input values do not
leave the adapter. Constructors have no I/O. The four-package runtime closure imports only Node
crypto/util and the pinned Sigstore packages. It has no network, keychain, filesystem, subprocess,
TUF, sign or ambient CLI adapter. Verification is synchronous: an Effect timeout cannot interrupt
it. Byte and collection bounds limit work but are not a CPU deadline. A killable confined process
is required before live untrusted admission. The acceptance harness tests trusted code in a
separate process with ordinary Node network access denied. Node's
[permission model](https://github.com/nodejs/node/blob/v26.0.0/doc/api/permissions.md)
does not protect against malicious code and is not an OS sandbox. The test harness is not a
production worker implementation or proof against a compromised SDK.

## Dependency and license record

| Package | Pin | License |
| --- | --- | --- |
| `@sigstore/verify` | `4.1.2` | Apache-2.0 |
| `@sigstore/bundle` | `5.0.0` | Apache-2.0 |
| `@sigstore/core` | `4.0.1` | Apache-2.0 |
| `@sigstore/protobuf-specs` | `0.5.2` | Apache-2.0 |

Direct pins and transitive overrides keep this four-package closure fixed. `bun.lock` records the
registry SHA-512 integrity strings. Installation used an empty configuration directory, explicit
public npm registry, isolated cache, no environment files and no lifecycle scripts. All 151
installed package files matched the isolated extracted cache. The original tarballs were not
retained, so their archive hashes were not independently recomputed. Published package attestation
verification is not claimed. The upstream fixture source tag is unsigned; its immutable source
commit and file hashes identify the copy but do not prove a trusted release publisher.

The verifier package does not include a license file. The unchanged Apache-2.0 license from the
bundle package is retained at `build/licenses/Sigstore-Apache-2.0.txt`, with all four packages
attributed in the shipped `NOTICE`. Electron Builder includes that license as an explicit resource.
Fixtures retain their upstream license and local extraction notice separately.

The SDK Node requirement is `^22.22.2 || ^24.15.0 || >=26.0.0`. This project supports
`^24.15.0 || >=26.0.0`; its Electron 44.9.3 runtime pins Node 24.22.0. The isolated local test uses
Node 26.0.0. Packaged Electron execution is not checked by this stage.

## Acceptance

Run `node --import tsx scripts/migration-offline-provenance-e2e.ts` with Node 26.0.0. The harness
bundles only this test and its service dependencies, stages four hash-pinned public files, and
starts one child with a clean environment. Checked `O_NOFOLLOW` reads reject symlinks, unexpected
owners, multiple links, oversized files and changed identities. The child can read only its bundle
and staged fixtures, and write only its exclusive report. Its ordinary network, subprocess,
addon and worker permissions are denied. The parent caps output and report sizes, waits for the
child's `close` event before cleanup, and publishes a fixed report after cleanup.

The local run passes 12 groups, six positive signature checks and 42 fixed-code refusals. It covers
signed-data tampering, missing evidence, exact identity checks, parser ambiguity, input bounds,
redaction and recovery. SCT removal also invalidates the certificate signature, so that case
proves certificate-tamper refusal rather than an isolated CT-threshold test. Evidence is written
to `.openbot-build/migration-offline-provenance/report.json`. A dedicated CI lane pins Node 26.0.0;
the existing application toolchain still uses `.nvmrc`. No CI result is claimed for the feature
branch stack.

## Remaining admission gates

A production path still needs approved authenticated root material and its update policy, a
specific owner-approved release tag/commit, genuine signed fork release evidence, certificate
workflow/repository/owner immutable-ID checks, strict authenticated in-toto/SLSA statement decoding,
and exact OCI index/platform-manifest/config digest binding. It must also prove what image the
paired server is running through an authenticated authority outside the server's self-report.
None of those facts comes from these fixtures. No real host, daemon, registry, account, private
key or user profile is used. Export, restore, activation, one-writer cutover and rollback remain
separate unfinished gates.
