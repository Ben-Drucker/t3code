import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import TranscriptSearchIndexes from "./Migrations/117_TranscriptSearchIndexes.ts";

describe("fork migration id reconciliation", () => {
  it.effect("upgrades a database that recorded the fork's migration 99", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "99_TranscriptSearchIndexes": TranscriptSearchIndexes }),
      });
      const applied = yield* runMigrations();
      assert.deepStrictEqual(applied[0], [100, "TurnStartReadIndexes"]);
      assert.deepStrictEqual(applied.at(-1), [117, "TranscriptSearchIndexes"]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.strictEqual(
        (yield* sql`
          SELECT name FROM sqlite_master
          WHERE name = 'orchestration_v2_projection_turn_items_usage_limit_idx'
        `).length,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
