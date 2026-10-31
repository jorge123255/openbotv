// Restricted synthetic reader, NOT Electron or OpenBot startup. Runs only inside the lab container.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db;
try {
  assert.equal(process.argv.length, 2);
  const config = JSON.parse(readFileSync("/fixture/config.json", "utf8"));
  assert.equal(config.format, "openbot-synthetic-projection-only");
  assert.equal(config.fullAppStartupAllowed, false);
  assert.equal(typeof config.storedRoot, "string");
  const mapped = (path) => {
    assert.equal(typeof path, "string");
    assert.ok(path.startsWith(`${config.storedRoot}/`));
    const suffix = path.slice(config.storedRoot.length + 1);
    assert.ok(suffix && !suffix.includes("\\") && !suffix.includes(":"));
    assert.ok(suffix.split("/").every((part) => part && part !== "." && part !== ".."));
    return join("/fixture/tree", suffix);
  };
  db = new DatabaseSync("/fixture/tree/userdata/openbot.db", { readOnly: true, allowExtension: false });
  db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
  assert.deepEqual(
    db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check),
    ["ok"],
  );
  const agents = db.prepare("SELECT agent_id,thread_id,agent_json FROM projection_agents").all();
  assert.equal(agents.length, 1);
  const agent = JSON.parse(agents[0].agent_json);
  assert.equal(agent.id, agents[0].agent_id);
  assert.ok(statSync(mapped(agent.workspacePath)).isDirectory());
  const messages = db.prepare("SELECT message_id,message_json FROM projection_thread_messages").all();
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(messages[0].message_json).id, messages[0].message_id);
  const stored = db.prepare("SELECT path,metadata_json FROM projection_attachments WHERE owner_kind='generated'").all();
  assert.equal(stored.length, 1);
  const attachment = JSON.parse(stored[0].metadata_json);
  assert.equal(attachment.path, stored[0].path);
  const bytes = readFileSync(mapped(attachment.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), attachment.sha256);
  assert.equal(bytes.length, attachment.size);
  assert.equal(db.prepare("SELECT path FROM projection_attachments WHERE owner_kind='thread-message'").get().path, "");
  assert.deepEqual(
    db
      .prepare("SELECT active FROM projection_agent_routines ORDER BY routine_id")
      .all()
      .map((row) => row.active),
    [1, 0],
  );
  const runs = db.prepare("SELECT count(*) AS total FROM projection_routine_runs").get().total;
  assert.equal(runs, 0);
  assert.equal(
    db.prepare("SELECT count(*) AS total FROM projection_provider_sessions WHERE state='active'").get().total,
    0,
  );
  const shared = new DatabaseSync("/fixture/tree/shared/Data/agent-data.db", { readOnly: true, allowExtension: false });
  let sharedTables = 0;
  try {
    shared.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const owners = shared.prepare("SELECT table_name,owner_agent_id FROM openbot_metadata").all();
    assert.equal(owners.length, 1);
    assert.equal(owners[0].owner_agent_id, agent.id);
    assert.equal(owners[0].table_name, "lab_notes");
    assert.equal(shared.prepare("SELECT count(*) AS total FROM lab_notes").get().total, 1);
    sharedTables = owners.length;
  } finally {
    shared.close();
  }
  let databaseWriteDenied = false;
  try {
    db.exec("CREATE TABLE synthetic_write_probe(value TEXT)");
  } catch (error) {
    databaseWriteDenied = error instanceof Error && /readonly|read-only/i.test(error.message);
  }
  assert.equal(databaseWriteDenied, true);
  let fixtureWriteDenied = false;
  try {
    writeFileSync("/fixture/write-probe", "must fail");
  } catch (error) {
    fixtureWriteDenied = error instanceof Error && "code" in error && ["EROFS", "EACCES"].includes(String(error.code));
  }
  assert.equal(fixtureWriteDenied, true);
  const externalInterfaces = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal);
  assert.equal(externalInterfaces.length, 0);
  // Machine-readable: fixed counts and booleans only. No IDs, paths, data or error causes.
  process.stdout.write(
    `${JSON.stringify({ scope: "restricted-synthetic-projection", databaseWriteDenied, fixtureWriteDenied, externalInterfaces: 0, agents: agents.length, messages: messages.length, attachments: stored.length, sharedTables, routineRuns: runs, fullAppStartupTested: false, realCredentialsVerified: false, duplicateExecutionProven: false, fullMigrationComplete: false })}\n`,
  );
} catch {
  process.stdout.write('{"scope":"restricted-synthetic-projection","failed":true}\n');
  process.exitCode = 1;
} finally {
  db?.close();
}
