import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeTranscriptRegexSearch } from "./TranscriptRegexSearch.ts";

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const search = yield* makeTranscriptRegexSearch(sql);
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, deleted_at, payload_json)
    VALUES ('live', 'project', 'Live', 'codex', 'full-access', 'default', ${at(1)}, ${at(1)}, NULL, '{}'),
           ('deleted', 'project', 'Deleted', 'codex', 'full-access', 'default', ${at(1)}, ${at(1)}, ${at(5)}, '{}')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES ('held', 'live', 1, 'pi', 'cancelled', ${at(1)}, '{}'),
           ('rolled-back', 'live', 2, 'pi', 'rolled_back', ${at(1)}, '{}')
  `;
  const insert = (
    id: string,
    day: number,
    kind: string,
    payload: object,
    thread = "live",
    run: string | null = null,
  ) => sql`
    INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${id}, ${thread}, ${run}, ${day}, ${kind}, 'completed', ${at(day)}, ${JSON.stringify(payload)})
  `;
  return { sql, search, insert };
});

it.live(
  "searches only selected readable transcript kinds and applies dates, provider and order before limit",
  () =>
    Effect.gen(function* () {
      const { search, insert } = yield* fixture;
      yield* insert("early", 1, "user_message", { text: "build #342" });
      yield* insert("answer", 2, "assistant_message", { text: "build #342" });
      yield* insert(
        "steer",
        3,
        "user_message",
        { text: "build #342", inputIntent: "steer" },
        "live",
        "held",
      );
      yield* insert("command", 4, "command_execution", {
        input: "build #342",
        output: "tests #342",
      });
      yield* insert("reason", 5, "reasoning", { text: "build #342", hidden: "secret" });
      yield* insert(
        "held",
        6,
        "user_message",
        { text: "build #342", inputIntent: "queued_turn" },
        "live",
        "held",
      );
      yield* insert("old", 7, "assistant_message", { text: "build #342" }, "live", "rolled-back");
      yield* insert("deleted", 8, "assistant_message", { text: "build #342" }, "deleted");
      const pattern = String.raw`\bbuild #\d+`;
      const ids = (result: { matches: ReadonlyArray<{ itemId: string }> }) =>
        result.matches.map((hit) => hit.itemId);
      expect(ids(yield* search({ pattern }))).toEqual(["steer", "answer", "early"]);
      const oldest = yield* search({ pattern, order: "oldest", limit: 1 });
      expect(ids(oldest)).toEqual(["early"]);
      expect(oldest.truncated).toBe(true);
      expect(ids(yield* search({ pattern, provider: "codex", start: at(2), end: at(3) }))).toEqual([
        "answer",
      ]);
      expect(ids(yield* search({ pattern, provider: "pi" }))).toEqual(["steer"]);
      expect(
        ids(yield* search({ pattern, includeToolCalls: true, includeReasoning: true })),
      ).toEqual(["reason", "command", "steer", "answer", "early"]);
      const output = yield* search({ pattern: "tests #342", includeToolResults: true });
      expect(output.matches).toMatchObject([
        { itemId: "command", excerpt: "tests #342", threadId: "live" },
      ]);
      expect(ids(yield* search({ pattern: "secret", includeReasoning: true }))).toEqual([]);
      expect((yield* search({ pattern: "[" })).invalidPattern).toBe(true);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.live("searches across pages of synthetic history and terminates a pathological regex", () =>
  Effect.gen(function* () {
    const { sql, search, insert } = yield* fixture;
    yield* sql`
      WITH RECURSIVE rows(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM rows WHERE i < 10000
      )
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      SELECT 'history-' || i, 'live', i, 'assistant_message', 'completed', ${at(2)},
             json_object('text', 'Routine synthetic transcript ' || i)
      FROM rows
    `;
    yield* insert("older-match", 1, "user_message", { text: "Issue ABC-1234 was fixed" });
    const result = yield* search({ pattern: "[A-Z]{3}-[0-9]{4}", timeoutMs: 3000 });
    expect(result).toMatchObject({
      matches: [{ itemId: "older-match", excerpt: "Issue ABC-1234 was fixed" }],
      timedOut: false,
      truncated: false,
    });
    yield* insert("large", 3, "assistant_message", { text: "x".repeat(140_000) });
    expect((yield* search({ pattern: ".", limit: 1 })).truncated).toBe(true);
    yield* insert("difficult", 4, "assistant_message", { text: "a".repeat(16_000) + "!" });
    expect(yield* search({ pattern: "(a+)+$", timeoutMs: 250 })).toMatchObject({
      matches: [],
      timedOut: true,
      truncated: true,
    });
    expect(
      (yield* search({ pattern: "ABC-1234", order: "oldest", limit: 1 })).matches[0]?.itemId,
    ).toBe("older-match");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
