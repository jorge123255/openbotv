// All data in this fixture is generated here. No provider or application service is constructed.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateOpenBotDatabase } from "../../src/backend/openbot-database-schema";
import { CREDENTIALS, ROOTS, sha256 } from "./snapshot-model";

const now = "2026-01-01T00:00:00.000Z";

export async function writeSyntheticHouse(root: string): Promise<void> {
  for (const path of ROOTS) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "shared/Transfers/generated-lab"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "shared/Data"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "workspace/agent-lab/empty"), { recursive: true, mode: 0o700 });
  const bytes = "Synthetic attachment, not a real user file.\n";
  await writeFile(join(root, "shared/Transfers/generated-lab/report.txt"), bytes, { mode: 0o600 });
  await writeFile(join(root, "workspace/agent-lab/notes.md"), "Keep quoted /synthetic-source paths unchanged.\n", {
    mode: 0o600,
  });
  await writeFile(
    join(root, "provider-home/session.json"),
    JSON.stringify({ sessionId: "external-lab", cursor: "cursor-lab", noCredentials: true }),
    { mode: 0o600 },
  );
  await writeFile(join(root, "userdata/credentials.json"), JSON.stringify(CREDENTIALS), { mode: 0o600 });
  await writeFile(join(root, "userdata/host.json"), JSON.stringify({ serverId: "server-lab", keys: "unavailable" }), {
    mode: 0o600,
  });
  await writeFile(
    join(root, "userdata/settings.json"),
    JSON.stringify({ timezone: "Etc/UTC", automaticTools: false }),
    { mode: 0o600 },
  );
  await writeFile(join(root, "browser/profile.txt"), "Synthetic profile without cookies.\n", { mode: 0o600 });
  await writeFile(join(root, "downloads/synthetic.txt"), "Synthetic download.\n", { mode: 0o600 });
  await writeFile(join(root, "skills/SKILL.md"), "Synthetic skill; never executed.\n", { mode: 0o600 });
  const summary = {
    id: "attachment-lab",
    name: "report.txt",
    size: Buffer.byteLength(bytes),
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  };
  const path = "/synthetic-source/shared/Transfers/generated-lab/report.txt";
  const db = new DatabaseSync(join(root, "userdata/openbot.db"));
  try {
    migrateOpenBotDatabase(db);
    db.prepare(
      "INSERT INTO projection_agents(agent_id,thread_id,model,updated_at,sort_order,agent_json,last_event_sequence) VALUES (?,?,?,?,?,?,1)",
    ).run(
      "agent-lab",
      "thread-lab",
      "synthetic",
      now,
      0,
      JSON.stringify({
        id: "agent-lab",
        threadId: "thread-lab",
        workspacePath: "/synthetic-source/workspace/agent-lab",
        providerAccountId: "account-lab",
      }),
    );
    db.prepare(
      "INSERT INTO projection_threads(thread_id,agent_id,title,created_at,updated_at,last_event_sequence) VALUES (?,?,?,?,?,1)",
    ).run("thread-lab", "agent-lab", "Synthetic history", now, now);
    db.prepare(
      "INSERT INTO projection_thread_messages(thread_id,message_id,author,status,created_at,ordinal,message_json,last_event_sequence) VALUES (?,?,?,?,?,0,?,1)",
    ).run(
      "thread-lab",
      "message-lab",
      "assistant",
      "completed",
      now,
      JSON.stringify({ id: "message-lab", text: "Saved synthetic history.", attachments: [summary] }),
    );
    db.prepare(
      "INSERT INTO projection_agent_memories(memory_id,agent_id,text,normalized_text,origin,created_at,updated_at,last_event_sequence) VALUES ('memory-lab','agent-lab','Tea','tea','manual',?,?,1)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projection_provider_sessions(id,thread_id,provider,external_session_id,model,effort,state,created_at,updated_at,resume_cursor,last_event_sequence) VALUES ('session-lab','thread-lab','codex','external-lab','synthetic','medium','inactive',?,?,'cursor-lab',1)",
    ).run(now, now);
    const routine = db.prepare(
      "INSERT INTO projection_agent_routines(routine_id,agent_id,name,instruction,active,timezone,created_at,updated_at,last_event_sequence,limit_policy,missed_policy) VALUES (?,'agent-lab','Synthetic routine','Never execute in rehearsal',?,'Etc/UTC',?,?,1,'wait','run-once')",
    );
    routine.run("routine-active", 1, now, now);
    routine.run("routine-paused", 0, now, now);
    db.prepare(
      "INSERT INTO projection_routine_triggers(trigger_id,routine_id,schedule_json,next_run_at,created_at,updated_at,last_event_sequence) VALUES ('trigger-lab','routine-active',?,?,?, ?,1)",
    ).run(JSON.stringify({ kind: "daily", time: "08:00" }), now, now, now);
    const attachment = db.prepare(
      "INSERT INTO projection_attachments(attachment_id,owner_kind,owner_id,name,path,metadata_json,created_at,last_event_sequence) VALUES (?,?,?,?,?,?,?,1)",
    );
    attachment.run(
      "attachment-lab",
      "generated",
      "attachment-lab",
      summary.name,
      path,
      JSON.stringify({
        ...summary,
        path,
        sha256: sha256(bytes),
        ownerAgentId: "agent-lab",
        ownerThreadId: "thread-lab",
      }),
      now,
    );
    attachment.run(
      "thread-lab:message-lab:attachment-lab",
      "thread-message",
      "thread-lab:message-lab",
      summary.name,
      "",
      JSON.stringify(summary),
      now,
    );
    db.prepare(
      "INSERT INTO orchestration_events(event_id,command_id,aggregate_type,aggregate_id,event_type,occurred_at,payload_json) VALUES ('event-lab','command-lab','synthetic','agent-lab','synthetic.fixture',?,'{}')",
    ).run(now);
    db.prepare(
      "INSERT INTO orchestration_command_receipts(command_id,accepted_at,first_sequence,last_sequence,result_json) VALUES ('command-lab',?,1,1,'{}')",
    ).run(now);
  } finally {
    db.close();
  }
  const shared = new DatabaseSync(join(root, "shared/Data/agent-data.db"));
  try {
    shared.exec(
      "CREATE TABLE openbot_metadata(table_name TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE lab_notes(note TEXT NOT NULL)",
    );
    shared.prepare("INSERT INTO openbot_metadata VALUES ('lab_notes','agent-lab',?)").run(now);
    shared.exec("INSERT INTO lab_notes VALUES ('Synthetic shared state')");
  } finally {
    shared.close();
  }
  const child = new DatabaseSync(join(root, "child-server/openbot.db"));
  try {
    migrateOpenBotDatabase(child);
  } finally {
    child.close();
  }
}
