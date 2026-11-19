// @effect-diagnostics nodeBuiltinImport:off -- A worker isolates and terminates backtracking regexes.
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

const PAGE_SIZE = 40;
const MAX_ROWS = 20_000;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
let pattern;
try { pattern = new RegExp(workerData.pattern, "u"); }
catch { parentPort.postMessage({ invalidPattern: true }); }
if (pattern) {
  parentPort.postMessage([]);
  parentPort.on("message", (rows) => {
    const results = [];
    for (const row of rows) {
      const item = JSON.parse(row.payload);
      const parts = [];
      switch (row.type) {
        case "command_execution":
        case "dynamic_tool":
          if (workerData.includeToolCalls) parts.push(item.commandSummary, item.toolName, item.input);
          if (workerData.includeToolResults) parts.push(item.output);
          break;
        case "file_search":
        case "web_search":
          if (workerData.includeToolCalls) parts.push(item.pattern, item.patterns);
          if (workerData.includeToolResults) parts.push(item.results);
          break;
        case "file_change":
          if (workerData.includeToolCalls) parts.push(item.fileName);
          if (workerData.includeToolResults) parts.push(item.diffStr ?? item.newStr);
          break;
        case "user_input_request":
          if (workerData.includeToolCalls) parts.push(item.questions);
          break;
        case "subagent":
          if (workerData.includeToolCalls && item.result == null && item.progress == null) parts.push(item.prompt);
          if (workerData.includeToolResults) parts.push(item.result ?? item.progress);
          break;
        default:
          parts.push(item.text);
      }
      for (const value of parts) {
        if (value === undefined || value === null) continue;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const match = pattern.exec(text);
        if (!match) continue;
        const start = Math.max(0, match.index - 80);
        const end = Math.min(text.length, Math.max(match.index + 160, start + 240));
        results.push({ itemId: row.itemId, threadId: row.threadId, updatedAt: row.updatedAt,
          type: row.type, provider: row.provider, excerpt:
            (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "") });
        break;
      }
    }
    parentPort.postMessage(results);
  });
}
`;

export interface TranscriptRegexInput {
  readonly pattern: string;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly provider?: string | undefined;
  readonly includeToolCalls?: boolean | undefined;
  readonly includeToolResults?: boolean | undefined;
  readonly includeReasoning?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly order?: "oldest" | "newest" | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface TranscriptRegexHit {
  readonly itemId: string;
  readonly threadId: string;
  readonly updatedAt: string;
  readonly type: string;
  readonly provider: string;
  readonly excerpt: string;
}

interface SearchRow extends Omit<TranscriptRegexHit, "excerpt"> {
  readonly eligible: number;
  readonly payload: string | null;
}

export const makeTranscriptRegexSearch = Effect.fn("ThreadSearch.makeTranscriptRegexSearch")(
  function* (sql: SqlClient.SqlClient) {
    const permit = yield* Semaphore.make(2);
    return Effect.fn("ThreadSearch.searchConversations")(function* (input: TranscriptRegexInput) {
      const types = [
        "user_message",
        "assistant_message",
        ...(input.includeReasoning ? ["reasoning"] : []),
        ...(input.includeToolCalls || input.includeToolResults
          ? [
              "command_execution",
              "dynamic_tool",
              "file_search",
              "web_search",
              "file_change",
              "user_input_request",
              "subagent",
            ]
          : []),
      ];
      const limit = input.limit ?? 20;
      const descending = input.order !== "oldest";
      const order = descending ? sql`DESC` : sql`ASC`;
      const start = input.start ?? "";
      const end = input.end ?? "9999";
      const provider = input.provider ?? null;
      const matches: TranscriptRegexHit[] = [];
      let truncated = false;
      let invalidPattern = false;
      const scan = Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* Effect.acquireRelease(
            Effect.sync(
              () => new NodeWorkerThreads.Worker(workerSource, { eval: true, workerData: input }),
            ),
            (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.ignore),
          );
          const read = (rows?: ReadonlyArray<SearchRow>) =>
            Effect.callback<TranscriptRegexHit[] | { invalidPattern: true }, Error>((resume) => {
              const dispose = () => {
                worker.off("message", receive);
                worker.off("error", fail);
              };
              const receive = (message: TranscriptRegexHit[] | { invalidPattern: true }) => {
                dispose();
                resume(Effect.succeed(message));
              };
              const fail = (cause: Error) => {
                dispose();
                resume(Effect.fail(cause));
              };
              worker.once("message", receive);
              worker.once("error", fail);
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
              if (rows !== undefined) worker.postMessage(rows);
              return Effect.sync(dispose);
            });
          const ready = yield* read();
          if (!Array.isArray(ready)) {
            invalidPattern = true;
            return;
          }
          let cursor: Pick<SearchRow, "updatedAt" | "itemId"> | undefined;
          for (let scanned = 0; scanned < MAX_ROWS; scanned += PAGE_SIZE) {
            const candidates = types.map(
              (type) => sql`
            SELECT * FROM (
              SELECT turn_item_id, thread_id, run_id, type, updated_at
              FROM orchestration_v2_projection_turn_items
              WHERE type = ${type} AND updated_at >= ${start} AND updated_at <= ${end}
                AND ${
                  cursor === undefined
                    ? sql`1`
                    : descending
                      ? sql`(updated_at, turn_item_id) < (${cursor.updatedAt}, ${cursor.itemId})`
                      : sql`(updated_at, turn_item_id) > (${cursor.updatedAt}, ${cursor.itemId})`
                }
              ORDER BY updated_at ${order}, turn_item_id ${order}
              LIMIT ${PAGE_SIZE}
            )`,
            );
            const rows: ReadonlyArray<SearchRow> = yield* sql<SearchRow>`
            WITH page AS MATERIALIZED (
              ${sql.join(" UNION ALL ", false)(candidates)}
              ORDER BY updated_at ${order}, turn_item_id ${order}
              LIMIT ${PAGE_SIZE}
            ), filtered AS MATERIALIZED (
              SELECT page.*, COALESCE(r.provider, t.default_provider) AS provider,
                (t.deleted_at IS NULL AND t.thread_id IS NOT NULL
                 AND COALESCE(r.status, '') <> 'rolled_back'
                 AND (${provider} IS NULL OR COALESCE(r.provider, t.default_provider) = ${provider})
                ) AS eligible, COALESCE(r.status, '') AS run_status
              FROM page
              LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = page.thread_id
              LEFT JOIN orchestration_v2_projection_runs AS r ON r.run_id = page.run_id
            )
            SELECT f.turn_item_id AS itemId, f.thread_id AS threadId, f.updated_at AS updatedAt,
              f.type, f.provider, f.eligible,
              CASE
                WHEN NOT f.eligible OR length(CAST(i.payload_json AS BLOB)) > ${MAX_PAYLOAD_BYTES} THEN NULL
                WHEN f.type = 'user_message' AND f.run_status IN ('queued', 'cancelled')
                  AND json_extract(i.payload_json, '$.inputIntent') = 'queued_turn' THEN ''
                ELSE i.payload_json
              END AS payload
            FROM filtered AS f
            JOIN orchestration_v2_projection_turn_items AS i ON i.turn_item_id = f.turn_item_id
            ORDER BY f.updated_at ${order}, f.turn_item_id ${order}`;
            cursor = rows.at(-1);
            if (rows.some((row) => row.eligible && row.payload === null)) truncated = true;
            const eligible = rows.filter((row) => row.payload);
            if (eligible.length > 0) {
              const hits = yield* read(eligible);
              if (Array.isArray(hits)) matches.push(...hits.slice(0, limit + 1 - matches.length));
            }
            if (matches.length > limit) {
              truncated = true;
              return;
            }
            if (rows.length < PAGE_SIZE) return;
          }
          truncated = true;
        }),
      );
      const completed = yield* permit
        .withPermits(1)(scan)
        .pipe(Effect.timeoutOption(input.timeoutMs ?? 3000));
      const timedOut = completed._tag === "None";
      return {
        matches: matches.slice(0, limit),
        timedOut,
        truncated: truncated || timedOut,
        invalidPattern,
      };
    });
  },
);
