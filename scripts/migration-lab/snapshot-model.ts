// Test-only format. This is not an application export/import contract.
import { createHash } from "node:crypto";
import { Schema } from "effect";

export const ROOTS = [
  "userdata",
  "workspace",
  "shared",
  "provider-home",
  "child-server",
  "browser",
  "downloads",
  "skills",
] as const;
const text = Schema.String.check(Schema.isMaxLength(4096));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const Entry = Schema.Struct({
  path: text,
  kind: Schema.Literals(["file", "directory"]),
  bytes: count,
  mode: count,
  sha256: digest,
});

const DatabaseInventory = Schema.Struct({
  path: text,
  schemaVersion: Schema.NullOr(count),
  schemaSha256: digest,
  tables: Schema.Array(Schema.Struct({ name: text, rows: count, sha256: digest })),
});

const CredentialInventory = Schema.Struct({
  apiKeys: Schema.Literal("reauthentication-required"),
  providerCliAccounts: Schema.Literal("reauthentication-required"),
  osKeychain: Schema.Literal("unavailable"),
  connectorsAndVault: Schema.Literal("unavailable"),
  hostAndIngressKeys: Schema.Literal("unavailable"),
  browserCookies: Schema.Literal("unavailable"),
  realSecretsRead: Schema.Literal(false),
});

export const Manifest = Schema.Struct({
  format: Schema.Literal("openbot-synthetic-snapshot-lab"),
  version: Schema.Literal(1),
  fixtureId: text,
  roots: Schema.Array(Schema.Literals(ROOTS)),
  entries: Schema.Array(Entry).check(Schema.isMaxLength(512)),
  databases: Schema.Array(DatabaseInventory),
  credentials: CredentialInventory,
  sourceVirtualRoot: Schema.Literal("/synthetic-source"),
  pathStatus: Schema.Literal("mapping-only-no-rewrite"),
  fullMigrationComplete: Schema.Literal(false),
});

export type SnapshotManifest = typeof Manifest.Type;
export type InventoryEntry = typeof Entry.Type;

export const CREDENTIALS: typeof CredentialInventory.Type = {
  apiKeys: "reauthentication-required",
  providerCliAccounts: "reauthentication-required",
  osKeychain: "unavailable",
  connectorsAndVault: "unavailable",
  hostAndIngressKeys: "unavailable",
  browserCookies: "unavailable",
  realSecretsRead: false,
};

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const FailureCode = Schema.Literals([
  "FIXTURE_IO",
  "SOURCE_NOT_STOPPED",
  "SOURCE_CHANGED",
  "UNSUPPORTED_ENTRY",
  "INVENTORY_LIMIT",
  "UNDECLARED_ROOT",
  "UNSAFE_PATH",
  "PORTABLE_PATH_COLLISION",
  "INVALID_MANIFEST",
  "SNAPSHOT_CHANGED",
  "INVENTORY_MISMATCH",
  "DATABASE_INVALID",
  "RELATIONSHIP_INVALID",
  "ATTACHMENT_INVALID",
  "SHARED_OWNER_INVALID",
  "TARGET_NOT_EMPTY",
  "NO_SNAPSHOT",
  "PATH_RELOCATION_UNSUPPORTED",
  "PATH_PROOF_FAILED",
]);

export class LabFailure extends Schema.TaggedError<LabFailure>()("LabFailure", { code: FailureCode }) {}

export function relativePath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    path.includes(":") ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part),
    ) ||
    [...path].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new LabFailure({ code: "UNSAFE_PATH" });
  }
  if (!ROOTS.some((root) => root === parts[0])) throw new LabFailure({ code: "UNDECLARED_ROOT" });
}
