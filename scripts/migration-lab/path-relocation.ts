// Synthetic fixture allowlist only. This is not a general application path migration adapter.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Schema } from "effect";
import { LabFailure, relativePath } from "./snapshot-model";

const Agent = Schema.Struct({ agent_id: Schema.String, agent_json: Schema.String, path: Schema.String });
const Attachment = Schema.Struct({
  attachment_id: Schema.String,
  path: Schema.String,
  metadata_json: Schema.String,
  metadata_path: Schema.String,
});
const TextResult = Schema.Struct({ text: Schema.String });

export function relativeStoredPath(path: string, storedRoot: string): string {
  const prefix = `${storedRoot}/`;
  if (!path.startsWith(prefix)) throw new LabFailure({ code: "UNSAFE_PATH" });
  const relative = path.slice(prefix.length);
  relativePath(relative);
  return relative;
}

function allowedRelative(path: string, storedRoot: string, category: "workspace" | "attachment"): string {
  const relative = relativeStoredPath(path, storedRoot);
  const prefix = category === "workspace" ? "workspace/" : "shared/Transfers/";
  if (!relative.startsWith(prefix) || relative === prefix) throw new LabFailure({ code: "UNSAFE_PATH" });
  return relative;
}

/** Normalize only allowlisted scalar fields for comparison against the original logical digest. */
export function normalizedRow(
  db: DatabaseSync,
  table: string,
  row: Record<string, SQLOutputValue>,
  storedRoot: string,
): Record<string, SQLOutputValue> {
  if (table === "projection_agents") {
    if (typeof row.agent_json !== "string") throw new LabFailure({ code: "PATH_PROOF_FAILED" });
    const path = Schema.decodeUnknownSync(TextResult)(
      db.prepare("SELECT json_extract(?, '$.workspacePath') AS text").get(row.agent_json),
    ).text;
    const relative = allowedRelative(path, storedRoot, "workspace");
    const text = Schema.decodeUnknownSync(TextResult)(
      db
        .prepare("SELECT json_set(?, '$.workspacePath', ?) AS text")
        .get(row.agent_json, `/synthetic-source/${relative}`),
    ).text;
    return { ...row, agent_json: text };
  }
  if (table === "projection_attachments" && row.owner_kind === "generated") {
    if (typeof row.path !== "string" || typeof row.metadata_json !== "string")
      throw new LabFailure({ code: "PATH_PROOF_FAILED" });
    const relative = allowedRelative(row.path, storedRoot, "attachment");
    const path = `/synthetic-source/${relative}`;
    const text = Schema.decodeUnknownSync(TextResult)(
      db.prepare("SELECT json_set(?, '$.path', ?) AS text").get(row.metadata_json, path),
    ).text;
    return { ...row, path, metadata_json: text };
  }
  return row;
}

/** Called only for the new staged copy of a lab-created database. Never touches the source. */
export async function relocateSyntheticDatabase(stage: string, finalRoot: string, failAfterFirst = false) {
  const db = new DatabaseSync(join(stage, "userdata/openbot.db"), { allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
    try {
      // Known path-bearing tables not covered by this fixture adapter must stay empty.
      for (const table of ["file_deletion_outbox", "projection_mcp_servers"]) {
        if (db.prepare(`SELECT count(*) AS total FROM ${table}`).get()?.total !== 0)
          throw new LabFailure({ code: "PATH_RELOCATION_UNSUPPORTED" });
      }
      if (
        db
          .prepare(
            "SELECT count(*) AS total FROM orchestration_events WHERE event_type <> 'synthetic.fixture' OR payload_json <> '{}'",
          )
          .get()?.total !== 0
      )
        throw new LabFailure({ code: "PATH_RELOCATION_UNSUPPORTED" });
      const agents = Schema.decodeUnknownSync(Schema.Array(Agent))(
        db
          .prepare(
            "SELECT agent_id,agent_json,json_extract(agent_json,'$.workspacePath') AS path FROM projection_agents",
          )
          .all(),
      );
      const attachments = Schema.decodeUnknownSync(Schema.Array(Attachment))(
        db
          .prepare(
            "SELECT attachment_id,path,metadata_json,json_extract(metadata_json,'$.path') AS metadata_path FROM projection_attachments WHERE owner_kind='generated'",
          )
          .all(),
      );
      let changed = 0;
      for (const agent of agents) {
        const relative = allowedRelative(agent.path, "/synthetic-source", "workspace");
        if (!(await lstat(join(stage, relative))).isDirectory()) throw new LabFailure({ code: "PATH_PROOF_FAILED" });
        db.prepare(
          "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.workspacePath',?) WHERE agent_id=?",
        ).run(`${finalRoot}/${relative}`, agent.agent_id);
        changed++;
        if (failAfterFirst) throw new LabFailure({ code: "FIXTURE_IO" });
      }
      for (const attachment of attachments) {
        if (attachment.path !== attachment.metadata_path) throw new LabFailure({ code: "PATH_PROOF_FAILED" });
        const relative = allowedRelative(attachment.path, "/synthetic-source", "attachment");
        if (!(await lstat(join(stage, relative))).isFile()) throw new LabFailure({ code: "PATH_PROOF_FAILED" });
        db.prepare(
          "UPDATE projection_attachments SET path=?,metadata_json=json_set(metadata_json,'$.path',?) WHERE attachment_id=?",
        ).run(`${finalRoot}/${relative}`, `${finalRoot}/${relative}`, attachment.attachment_id);
        changed += 2;
      }
      db.exec("COMMIT");
      return changed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
