import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_transcript_search_idx
    ON orchestration_v2_projection_turn_items(type, updated_at, turn_item_id)
  `;
});
