import type { DatabaseSync } from "node:sqlite";

/** Collapse whitespace so a search can match a phrase split by a line break. */
export const COLLAPSE_WHITESPACE_FUNCTION = "openbot_collapse_whitespace";

/** SQLite LOWER covers ASCII only; attachment search needs Unicode lowercase. */
export const LOWERCASE_FUNCTION = "openbot_lowercase";

/** Installs deterministic in-memory functions without opening or changing a database. */
export function registerSearchSqlFunctions(db: Pick<DatabaseSync, "function">): void {
  db.function(COLLAPSE_WHITESPACE_FUNCTION, { deterministic: true }, (value) =>
    typeof value === "string" ? value.replace(/\s+/gu, " ") : value,
  );
  db.function(LOWERCASE_FUNCTION, { deterministic: true }, (value) =>
    typeof value === "string" ? value.toLocaleLowerCase() : value,
  );
}
