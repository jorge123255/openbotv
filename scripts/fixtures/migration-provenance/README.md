# Public Sigstore verification fixtures

These files are **fixture-only**. They do not establish production trust in an OpenBot release,
repository, publisher, destination or runtime. They contain no private key. No key pair, certificate,
signature, timestamp or log entry was generated for this copy.

The source is `sigstore/sigstore-js`, tag `@sigstore/verify@4.1.2`, commit
`769a53d8713248a8bf49edfc2a5d1955b0dcc24d`. GitHub MCP returned the source blobs at that immutable
commit. The tag is an unsigned annotated tag. `SOURCE.json` records the tag object, source URLs,
Git blob SHA-1 values, recomputed source SHA-256 values, extraction method and local file hashes.
These records identify the copied source. They are not publisher signature verification.

| File | Public source data | Expected use |
| --- | --- | --- |
| `trusted-root.fixture.sigstore` | `trustedRootJSON` from upstream `trust.ts` | Convert with `TrustedRoot.fromJSON`; use only in an explicitly fixture-scoped verifier. |
| `message-signature.bundle.sigstore` | `V3.MESSAGE_SIGNATURE.TLOG_HASHEDREKORDV002` | Decode with `bundleFromJSON`; call `toSignedEntity(bundle, artifactBytes)`. |
| `dsse.bundle.sigstore` | `V3.DSSE.WITH_SIGNING_CERT.TLOG_DSSEV002` | Decode with `bundleFromJSON`; call `toSignedEntity(bundle)`. |
| `artifact.txt` | Upstream `ARTIFACT` | Exactly 13 UTF-8 bytes: `hello, world!`, with no trailing newline. |

Both selected bundles use media type `application/vnd.dev.sigstore.bundle.v0.3+json` and a signing
certificate in `verificationMaterial.certificate`. They include a Rekor v2 Merkle inclusion proof,
signed checkpoint and RFC 3161 timestamp. Their certificate SCTs exercise CT verification. Upstream
tests accept these two vectors with the default verifier thresholds. Keep `ctlogThreshold: 1`,
`tlogThreshold: 1` and `timestampThreshold: 1`; do not lower them to make a test pass.

The unapproved fixture certificate has an email SAN. The SDK SAN literal is `brian@dehamer.com`,
with issuer `https://github.com/login/oauth`. Node's X509 diagnostic displays
`email:brian@dehamer.com`; the `email:` prefix is not part of the SDK comparison value.
This is not the approved fork's GitHub Actions release identity.
Cryptographic acceptance under this fixture root must therefore be followed by refusal under the
OpenBot fork release policy. The DSSE payload is the same `hello, world!` bytes with content type
`text/plain`. It is not an in-toto statement, SLSA provenance or a signed OCI release subject.

The full upstream public fixture root is retained. It includes historical certificate/log keys and
mock timestamp authority material. Its URL fields are metadata, not permission to contact those
addresses. The root is not a production TUF snapshot, root update policy or trusted-root inventory.
Historical signing times and signed fields must not be changed to fit the current date.

Extraction read only literal objects, arrays, strings, numbers, booleans, `null` and `undefined`.
It did not execute upstream TypeScript, imports or functions. Object properties whose value was
`undefined` were omitted as `JSON.stringify` would omit them. Outer JSON formatting changed. Signed
DSSE payloads, certificates, log bodies, checkpoints, signatures and timestamp bytes were copied
without modification. A separate normalization step uses the pinned `@sigstore/bundle@5.0.0`
`bundleFromJSON` and `bundleToJSON` functions. For the message bundle only, this removes two unsigned
protobuf defaults: `tlogEntries[0].integratedTime` with value `"0"` and `inclusionPromise` with value
`null`. The DSSE bundle has no such changes. All other fields remain deep-equal to the extracted data.
Both normalized bundles pass actual SDK verification with CT, log and timestamp thresholds all set
to 1, under the fixture-only root.

The root and two bundle files use the byte-oriented .sigstore extension. They contain raw JSON,
not a different signature format. This keeps general JSON formatting from rewriting the pinned
canonical fixture bytes; no formatter rule or configuration is disabled.

The files use canonical minified `JSON.stringify` encoding
with one terminal LF. The adapter admits that encoding with either no terminal LF or one terminal LF;
it must reject duplicate keys, extra whitespace and other encodings before SDK conversion. Bundle
JSON must also deep-equal its pinned SDK protobuf roundtrip before cryptographic verification. This
refuses ambiguous one-of fields and noncanonical base64 instead of accepting the decoder's choice.
The local hashes in `SOURCE.json` cover the exact checked-in file bytes, including the terminal LF.

The source tests establish the expected results. The consuming acceptance script must repeat the
checks through the approved installed SDK. Positive production admission still requires a genuine
approved-fork bundle, a concrete approved release tag and immutable identities, a separately approved
production root policy, exact artifact subject binding, and runtime binding. These fixtures supply
none of those production facts.

The upstream Apache-2.0 license is included in `LICENSE`. `NOTICE` records attribution and local
extraction changes.
