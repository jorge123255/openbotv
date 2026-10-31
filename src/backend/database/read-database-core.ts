import type { StatementSync } from "node:sqlite";

/**
 * Read controllers obtain the current connection at each use; this port owns no lifecycle.
 * This type limits dependencies. SQLite read-only mode and process confinement reject writes.
 */
export interface ReadDatabaseCore {
  readonly connection: {
    prepare(sql: string): Pick<StatementSync, "get" | "all">;
  };
}
