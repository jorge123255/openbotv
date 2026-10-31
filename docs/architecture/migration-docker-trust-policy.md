# Approved Docker migration policy status

The approved first scope is Docker to Docker, using builds from `jorge123255/openbotv` through
`.github/workflows/release.yml` and an explicitly approved release tag. Local/custom builds have no
trust path in this version. Both ends must meet the exact same verified Linux platform artifact
identity. A matching version, tag, multi-platform index or host-reported digest is insufficient.

The actual local Server settings show **Approved migration policy** after a Docker preparation plan
is saved. The read-only panel shows the approved repository, workflow, issuer, image repository and
exact-build rule. It also shows that no specific release tag has been approved and all five required
providers are unavailable. It does not connect to a destination or verify an artifact.

## Production boundary

[MigrationDestinationPolicyService](../../src/main/migration-destination-policy.ts) is constructed
beside preparation and assessment in the actual application service graph. Its constructor performs
no IO. `getState` samples the existing preparation metadata twice, detaches its UUID/revision/kind/
status, and marks a changed binding stale. It does not use assessment facts or rewrite either journal.
`current` means only an observed prepared Docker-target binding. It does not prove that the source
runs in Docker, that either host is trusted, or that the observation is still current elsewhere.

The new local-only `migrationDestinationPolicy.getState()` accepts no payload. Main checks the
trusted sender before rejecting tag, URL, key, credential, evidence or server overrides. The preload
has an independent closed decoder. The functional preview reads the current preparation mock lazily.
No released Team route or codec changes. There is no remote destination capability in this slice.

The status contract admits only `blocked` or `out-of-scope`. Its approved tag is always null. Its
release approval, provenance, runtime binding, pairing approval and source authentication fields are
always false, as are destination verification, complete inventory and export/restore/activation.
All six preparation blockers remain. There is no evidence-input adapter, `{verified:true}` port,
opaque trusted-handle issuer, approval writer, environment override, credential creation or grant.
Neither the synthetic verifier's public RFC keys nor its fixture result can enter this contract.

The UI appears only for a local, host-confirmed, non-Windows, prepared Docker target. It compares
the response with both the starting and current preparation binding before showing details. A stale
or delayed response cannot become policy details for another plan. Local-desktop, other-server,
cancelled, remote, Windows and unconfirmed-host states do not request this status. Windows and other
unsupported platforms also refuse in main before reading preparation storage; POSIX checks stay intact.

## Required evidence providers

The repository is configured to generate GitHub provenance in its release workflow, including an
OCI index attestation. That is useful infrastructure, not a runtime trust decision. No release was
downloaded or validated for this change, and no Sigstore runtime verifier is installed. Existing
cryptographic primitives are not a substitute for a reviewed complete Sigstore verifier.

| Unavailable provider | Requirement before admission |
| --- | --- |
| Specific release approval | A source-owned approval of an exact release tag and immutable release identity. Do not infer approval from `latest`, an application version, a host response or renderer input. |
| Attestation verifier | Verify provenance signature, certificate, transparency/trust-root evidence and exact subject against the approved fork, release workflow, GitHub issuer and approved release ref policy. Missing/unverifiable evidence must refuse. |
| Runtime binding | Bind the verified OCI artifact chain to the actual source and destination runtime instances. A label, environment variable, marker file, config ID or self-reported digest cannot issue this evidence. |
| Pairing approval | Establish approved pin provenance bound to source identity, destination identity/key, exact origin and current authority. A saved directory advertisement is insufficient. |
| Source authentication | Authenticate an established source identity and the complete purpose-bound request with source-owner and destination-owner/admin authority. Do not create or rotate an identity to satisfy a missing prerequisite. |

The publisher/scope choice is settled; these are missing engineering components. This status has no
hidden success path. Actual admission needs those components and a separate connected workflow.

The future verifier must enforce publisher/workflow/ref through authenticated certificate claims,
not fields merely asserted in a provenance predicate. Pin the approved repository's immutable
identity as well as its display name, exact workflow/source identity and approved tag-to-commit
binding. Offline bundles alone cannot detect later repository-name reuse. These requirements follow
[GitHub's attestation verification model](https://cli.github.com/manual/gh_attestation_verify) and
[OIDC identity claims](https://docs.github.com/en/actions/reference/security/oidc). No repository IDs
or release approvals are guessed by this status feature.

## Exact OCI identity

The first build rule requires the same approved index, selected Linux platform manifest and image
configuration identities on both ends. An OCI index can contain different architecture images, so
matching the index alone cannot admit a move. Architecture/platform changes must block this version.

A future evidence adapter must verify the authenticated index subject and hash its **exact raw bytes**.
Select one unambiguous Linux platform descriptor; verify the raw child manifest digest and size;
then verify the referenced config bytes/digest and platform. Follow the approved provenance chain
to that selection. Do not hash a JSON reserialization, substitute a Docker config ID for a manifest
digest, or substitute an image tag for any digest. Layer/content coverage and runtime-instance binding
must be explicit in the real adapter. This slice implements no OCI/Sigstore/runtime verifier and
does not represent normalized fixture facts as verified artifacts.

No Docker/libvirt socket, privileged container access, daemon operation or trust-root change is
added. Future standalone/custom-build trust remains a separate reviewed path.

## Focused verification

```sh
node --import tsx scripts/migration-destination-policy-e2e.ts
bun run test:desktop -- src/main/ipc/migration-destination-policy-handlers.test.ts --maxWorkers=1
bun run test:desktop -- src/main/ipc-channel-coverage.test.ts --maxWorkers=1
bun run storybook --no-open --quiet
# Use the loopback URL printed by the registered wrapper:
node --import tsx scripts/migration-destination-policy-ui-e2e.ts --url=http://localhost:6006
```

Generated profiles exercise the actual preparation/policy services, trusted IPC binder, independent
decoder and Settings components. Browser calls use a story-only service bridge; actual IPC trust is
tested separately. Evidence is under `.openbot-build/migration-destination-policy{,-ui}-e2e/`.
Scope exclusions, stale/replaced plans, fixed errors, strict no-argument and response boundaries,
unchanged source bytes, zero routine runs and disabled migration actions are acceptance conditions.
No real account, provider, credential store, release, destination or production app is used.

## Next connected slice

Use a vetted attestation verifier and reviewed trust policy to issue an internal evidence handle
only after the approved release and full OCI chain have verified. Add an independently trusted
runtime provider and approved pairing/source-auth records. Bind that evidence to plan, assessment,
selected destination, artifact and runtime instance with expiry. Then add the authenticated capability
route and coordinator, followed by trusted IPC/independent preload/UI integration. Test the actual
components through owned mock endpoints before adding a live HTTPS adapter. Keep export, restore,
activation and credential handling unavailable throughout this verification stage.
