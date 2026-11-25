import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import BackgroundRecoveryIndexes from "./Migrations/099_BackgroundRecoveryIndexes.ts";

// Fork builds recorded 99_TranscriptSearchIndexes before upstream claimed id 99; that index now
// runs idempotently as 117, so the row gets upstream's migration and name.
export const reconcileForkMigrationIds = Effect.fn("reconcileForkMigrationIds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM effect_sql_migrations WHERE migration_id = 99
  `;
  if (rows[0]?.name !== "TranscriptSearchIndexes") return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* BackgroundRecoveryIndexes;
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'BackgroundRecoveryIndexes' WHERE migration_id = 99
      `;
    }),
  );
});
