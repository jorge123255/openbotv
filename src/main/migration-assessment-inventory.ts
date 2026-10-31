import { posix, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { agentProviderDescriptor, isAgentProvider } from "@openbot/contracts/agent-providers";
import type { DesktopPlatform } from "@openbot/contracts/ipc";
import {
  MIGRATION_ASSESSMENT_CATEGORIES,
  type MigrationAssessmentInventory,
} from "@openbot/contracts/ipc-migration-assessment";
import { Effect, Schema } from "effect";
import { MIGRATION_ASSESSMENT_EXPECTED_SCHEMA, MIGRATION_ASSESSMENT_TABLES } from "./migration-assessment-registry";

const ROW_LIMIT = 10_000;
const PATH_LIMIT = 4_096;
const TABLES = Object.values(MIGRATION_ASSESSMENT_TABLES).flat();
const TABLE_SET = new Set<string>(TABLES);
const NumberValue = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2_147_483_647));
const CountRows = Schema.Array(Schema.Struct({ name: Schema.String, count: NumberValue }));
const SchemaRows = Schema.Array(Schema.Struct({ name: Schema.String }));
const PathRows = Schema.Array(Schema.Struct({ kind: Schema.String, value: Schema.NullOr(Schema.String) }));
const AgentRows = Schema.Array(
  Schema.Struct({ provider: Schema.NullOr(Schema.String), access: Schema.NullOr(Schema.String) }),
);
const Live = Schema.Struct({
  providerSessions: NumberValue,
  pendingDeliveries: NumberValue,
  activeRoutines: NumberValue,
  workflowRuns: NumberValue,
  workflowSteps: NumberValue,
  pendingResultDeliveries: NumberValue,
  waits: NumberValue,
});
const Metadata = Schema.Struct({
  counts: Schema.String,
  paths: Schema.String,
  agents: Schema.String,
  live: Schema.String,
  schemaNames: Schema.String,
  schemaVersion: Schema.NullOr(NumberValue),
});
const Version = Schema.Struct({ version: Schema.NullOr(NumberValue), count: NumberValue });

export class MigrationAssessmentInventoryFailure extends Schema.TaggedError<MigrationAssessmentInventoryFailure>()(
  "MigrationAssessmentInventoryFailure",
  { code: Schema.Literals(["unavailable", "limit-exceeded"]) },
) {}

export interface MigrationAssessmentInventoryOptions {
  connection: () => Pick<DatabaseSync, "prepare">;
  userDataRoot: string;
  managedRoot: string;
  sourcePlatform: DesktopPlatform;
}

function parse<A>(schema: Schema.Codec<A>, value: string): A {
  return Schema.decodeUnknownSync(schema)(JSON.parse(value));
}

function tableCount(table: string): string {
  return `SELECT '${table}' AS name, (SELECT count(*) FROM (SELECT 1 FROM ${table} LIMIT ${ROW_LIMIT + 1})) AS count`;
}

function liveCount(table: string, predicate = "1", column = "status"): string {
  // LIMIT precedes the filter. A rare status must not scan an unlimited history table.
  return `(SELECT count(*) FROM (SELECT ${column} FROM ${table} LIMIT ${ROW_LIMIT}) WHERE ${predicate})`;
}

const LIVE_TABLES = [
  "projection_provider_sessions",
  "projection_deliveries",
  "projection_agent_routines",
  "projection_channel_routines",
  "workflow_runs",
  "workflow_steps",
  "routine_result_deliveries",
  "workflow_output_deliveries",
  "agent_waits",
  "projection_agents",
];

// Only named path and access fields leave SQLite. Secret-bearing JSON and provider cursors do not.
const METADATA_SQL = `WITH
  bounded_agents AS (
    SELECT CASE WHEN length(agent_json) > 262144 THEN '{}'
      WHEN json_valid(agent_json) THEN agent_json ELSE '{}' END AS data
    FROM projection_agents LIMIT ${ROW_LIMIT}
  ),
  path_refs AS (
    SELECT 'workspace' AS kind,
      CASE WHEN json_type(data, '$.workspacePath') = 'text' THEN substr(json_extract(data, '$.workspacePath'), 1, 4097) END AS value
      FROM bounded_agents
    UNION ALL
    SELECT 'folder', CASE WHEN j.type = 'text' THEN substr(j.value, 1, 4097) END
      FROM bounded_agents a, json_each(CASE WHEN json_type(a.data, '$.additionalFolders') = 'array'
        THEN json_extract(a.data, '$.additionalFolders') ELSE '[]' END) j
    UNION ALL
    SELECT 'folder', CASE WHEN j.type = 'text' THEN substr(j.value, 1, 4097) END
      FROM bounded_agents a, json_each(CASE WHEN json_type(a.data, '$.excludedFolders') = 'array'
        THEN json_extract(a.data, '$.excludedFolders') ELSE '[]' END) j
    UNION ALL
    SELECT 'invalid', NULL FROM bounded_agents WHERE
      (json_type(data, '$.additionalFolders') IS NOT NULL AND json_type(data, '$.additionalFolders') <> 'array') OR
      (json_type(data, '$.excludedFolders') IS NOT NULL AND json_type(data, '$.excludedFolders') <> 'array')
    UNION ALL
    SELECT CASE WHEN owner_kind = 'thread-message' THEN 'summary' ELSE 'attachment' END, substr(path, 1, 4097)
      FROM (SELECT owner_kind, path FROM projection_attachments LIMIT ${ROW_LIMIT})
    UNION ALL
    SELECT 'attachment-metadata',
      CASE WHEN length(metadata_json) > 262144 THEN NULL
        WHEN json_valid(metadata_json) THEN CASE WHEN json_type(metadata_json, '$.path') = 'text'
          THEN substr(json_extract(metadata_json, '$.path'), 1, 4097) END END
      FROM (SELECT owner_kind, metadata_json FROM projection_attachments LIMIT ${ROW_LIMIT}) WHERE owner_kind <> 'thread-message'
    UNION ALL
    SELECT 'deletion', substr(path, 1, 4097) FROM (SELECT path FROM file_deletion_outbox LIMIT ${ROW_LIMIT})
    UNION ALL
    SELECT 'mcp', substr(working_directory, 1, 4097)
      FROM (SELECT working_directory FROM projection_mcp_servers LIMIT ${ROW_LIMIT})
  )
  SELECT
    (SELECT json_group_array(json_object('name', name)) FROM
      (SELECT CASE WHEN length(name) <= 128 THEN name ELSE '' END AS name FROM sqlite_schema WHERE type = 'table' LIMIT ${TABLES.length + 1})) AS schemaNames,
    (SELECT max(version) FROM (SELECT version FROM schema_migrations LIMIT 1001)) AS schemaVersion,
    (SELECT json_group_array(json_object('name', name, 'count', count)) FROM (${TABLES.map(tableCount).join(" UNION ALL ")})) AS counts,
    (SELECT json_group_array(json_object('kind', kind, 'value', value)) FROM (SELECT kind, value FROM path_refs LIMIT ${PATH_LIMIT + 1})) AS paths,
    (SELECT json_group_array(json_object(
      'provider', CASE WHEN json_type(data, '$.provider') = 'text' THEN substr(json_extract(data, '$.provider'), 1, 65) END,
      'access', CASE WHEN json_type(data, '$.access') = 'text' THEN substr(json_extract(data, '$.access'), 1, 17)
        WHEN json_type(data, '$.access') IS NULL THEN 'full' END)) FROM bounded_agents) AS agents,
    json_object(
      'providerSessions', ${liveCount("projection_provider_sessions", "state = 'active'", "state")},
      'pendingDeliveries', ${liveCount("projection_deliveries", "status IN ('queued','starting','running')")},
      'activeRoutines', ${liveCount("projection_agent_routines", "active = 1", "active")} + ${liveCount("projection_channel_routines", "active = 1", "active")},
      'workflowRuns', ${liveCount("workflow_runs", "status IN ('running','approval','stopping')")},
      'workflowSteps', ${liveCount("workflow_steps", "status IN ('running','approval')")},
      'pendingResultDeliveries', ${liveCount("routine_result_deliveries", "status IN ('pending','sending','uncertain')")} +
        ${liveCount("workflow_output_deliveries", "status IN ('pending','sending','uncertain')")},
      'waits', ${liveCount("agent_waits", "1", "1")}
    ) AS live`;

function pathsNotInspected(): MigrationAssessmentInventory["paths"] {
  return {
    managed: 0,
    userData: 0,
    external: 0,
    relative: 0,
    uri: 0,
    invalid: 0,
    defaults: 0,
    summaryReferences: 0,
    truncated: false,
    coverage: "not-inspected",
    containment: "lexical-only",
    symlinks: "not-inspected",
  };
}

function unknownLive(): MigrationAssessmentInventory["liveState"] {
  return {
    providerSessions: null,
    pendingDeliveries: null,
    activeRoutines: null,
    workflowRuns: null,
    workflowSteps: null,
    pendingResultDeliveries: null,
    waits: null,
    confinedProcessAgents: null,
    countKind: "unknown",
  };
}

function pathCounts(
  rows: typeof PathRows.Type,
  options: MigrationAssessmentInventoryOptions,
  clipped: boolean,
): MigrationAssessmentInventory["paths"] {
  const result = {
    ...pathsNotInspected(),
    coverage: "metadata-extracted" as const,
    truncated: clipped || rows.length > PATH_LIMIT,
  };
  const path = options.sourcePlatform === "win32" ? win32 : posix;
  function inside(root: string, value: string): boolean {
    const relative = path.relative(root, value);
    return (
      relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  }
  for (const row of rows.slice(0, PATH_LIMIT)) {
    const value = row.value;
    if (row.kind === "summary" && value === "") result.summaryReferences++;
    else if (row.kind === "summary") result.invalid++;
    else if (row.kind === "mcp" && value === "") result.defaults++;
    else if (
      value === null ||
      value.length === 0 ||
      value.length > 4096 ||
      Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      result.invalid++;
    else if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) result.uri++;
    else if (!path.isAbsolute(value)) result.relative++;
    else if (inside(options.userDataRoot, value)) result.userData++;
    else if (inside(options.managedRoot, value)) result.managed++;
    else result.external++;
  }
  return result;
}

/** Provisional SQL metadata only. No files or secret stores are read. Stored live intent is not
 * proof of running processes, idle writers or a consistent filesystem snapshot. Row limits do not
 * provide a wall-clock timeout for synchronous SQLite or JSON decoding.
 */
export const readMigrationAssessmentInventory = Effect.fn("MigrationAssessmentInventory.read")(function* (
  options: MigrationAssessmentInventoryOptions,
) {
  return yield* Effect.try({
    try: (): MigrationAssessmentInventory => {
      const path = options.sourcePlatform === "win32" ? win32 : posix;
      if (!path.isAbsolute(options.userDataRoot) || !path.isAbsolute(options.managedRoot))
        throw new Error("invalid roots");
      const db = options.connection();
      const names = Schema.decodeUnknownSync(SchemaRows)(
        db
          .prepare(
            `SELECT CASE WHEN length(name) <= 128 THEN name ELSE '' END AS name FROM sqlite_schema WHERE type = 'table' LIMIT ${TABLES.length + 1}`,
          )
          .all(),
      ).map((row) => row.name);
      let observedVersion: number | null = null;
      if (names.includes("schema_migrations")) {
        const version = Schema.decodeUnknownSync(Version)(
          db
            .prepare(
              "SELECT max(version) AS version, count(*) AS count FROM (SELECT version FROM schema_migrations LIMIT 1001)",
            )
            .get(),
        );
        if (version.count <= 1000) observedVersion = version.version;
      }
      const recognized =
        names.length === TABLES.length &&
        names.every((name) => TABLE_SET.has(name)) &&
        observedVersion === MIGRATION_ASSESSMENT_EXPECTED_SCHEMA;
      const schema = {
        expectedVersion: MIGRATION_ASSESSMENT_EXPECTED_SCHEMA,
        observedVersion,
        recognized,
        unmappedTables: names.filter((name) => !TABLE_SET.has(name)).length,
      };
      const credentials = {
        coverage: "not-inspected",
        reauthentication: "unresolved",
        deviceBound: "unknown",
      } as const;
      if (!recognized)
        return {
          categories: MIGRATION_ASSESSMENT_CATEGORIES.map((category) => ({
            category,
            rowCount: null,
            countKind: "unknown",
            coverage: Object.hasOwn(MIGRATION_ASSESSMENT_TABLES, category) ? "unrecognized-schema" : "not-inspected",
          })),
          schema,
          paths: pathsNotInspected(),
          liveState: unknownLive(),
          credentials,
        };
      const raw = Schema.decodeUnknownSync(Metadata)(db.prepare(METADATA_SQL).get());
      const readNames = parse(SchemaRows, raw.schemaNames).map((row) => row.name);
      if (
        readNames.length !== TABLES.length ||
        readNames.some((name) => !TABLE_SET.has(name)) ||
        raw.schemaVersion !== MIGRATION_ASSESSMENT_EXPECTED_SCHEMA
      )
        throw new Error("schema changed");
      const counts = new Map(parse(CountRows, raw.counts).map((row) => [row.name, row.count]));
      const categories = MIGRATION_ASSESSMENT_CATEGORIES.map((category) => {
        const tables = Object.entries(MIGRATION_ASSESSMENT_TABLES).find(([key]) => key === category)?.[1];
        if (!tables) return { category, coverage: "not-inspected", rowCount: null, countKind: "unknown" } as const;
        let total = 0;
        let clipped = false;
        for (const table of tables) {
          const count = counts.get(table);
          if (count === undefined || count > ROW_LIMIT + 1) throw new Error("invalid count");
          total += Math.min(count, ROW_LIMIT);
          clipped ||= count > ROW_LIMIT;
        }
        return {
          category,
          coverage: "metadata-counted",
          rowCount: total,
          countKind: clipped ? "at-least" : "exact",
        } as const;
      });
      let confinedProcessAgents = 0;
      let agentUnknown = false;
      for (const agent of parse(AgentRows, raw.agents)) {
        if (!isAgentProvider(agent.provider) || (agent.access !== "workspace" && agent.access !== "full"))
          agentUnknown = true;
        else if (
          agent.access === "workspace" &&
          agentProviderDescriptor(agent.provider).workspaceEnforcement === "confined-process"
        )
          confinedProcessAgents++;
      }
      const liveState = agentUnknown
        ? unknownLive()
        : {
            ...parse(Live, raw.live),
            confinedProcessAgents,
            countKind: LIVE_TABLES.some((table) => (counts.get(table) ?? 0) > ROW_LIMIT)
              ? ("at-least" as const)
              : ("exact" as const),
          };
      const paths = pathCounts(
        parse(PathRows, raw.paths),
        options,
        ["projection_agents", "projection_attachments", "file_deletion_outbox", "projection_mcp_servers"].some(
          (table) => (counts.get(table) ?? 0) > ROW_LIMIT,
        ),
      );
      return { categories, schema, paths, liveState, credentials };
    },
    catch: () => new MigrationAssessmentInventoryFailure({ code: "unavailable" }),
  });
});
