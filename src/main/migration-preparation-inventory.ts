import type { DatabaseSync } from "node:sqlite";
import { MIGRATION_PREPARATION_MAX_COUNT, type MigrationPreparationInventory } from "@openbot/contracts/ipc";
import { Effect, Schema } from "effect";
import { MigrationPreparationFailure } from "./migration-preparation";

const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MIGRATION_PREPARATION_MAX_COUNT),
);
const Inventory = Schema.Struct({
  agents: Count,
  conversations: Count,
  messages: Count,
  attachments: Count,
  routines: Count,
});

/** One statement against the initialized facade. No files, credentials or provider APIs are read.
 * Attachment indices for messages repeat canonical attachment rows and are excluded.
 * These counts are provisional metadata, not a consistent filesystem snapshot.
 */
export function readMigrationPreparationInventory(
  connection: () => Pick<DatabaseSync, "prepare">,
): Effect.Effect<MigrationPreparationInventory, MigrationPreparationFailure> {
  return Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Inventory)(
        connection()
          .prepare(`SELECT
            (SELECT count(*) FROM projection_agents) AS agents,
            (SELECT count(*) FROM projection_threads) AS conversations,
            (SELECT count(*) FROM projection_thread_messages) AS messages,
            (SELECT count(*) FROM projection_attachments WHERE owner_kind <> 'thread-message') AS attachments,
            (SELECT count(*) FROM projection_agent_routines) AS routines`)
          .get(),
      ),
    catch: () => new MigrationPreparationFailure({ code: "inventory-unavailable" }),
  });
}
