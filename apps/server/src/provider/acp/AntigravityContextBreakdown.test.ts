import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  antigravityBreakdownFromGeneration,
  antigravityUsageFromGeneration,
  readAntigravityContextUsage,
} from "./AntigravityContextBreakdown.ts";

const varint = (value: number) => {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};
const int = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const bytes = (field: number, payload: ReadonlyArray<number>) => [
  ...varint((field << 3) | 2),
  ...varint(payload.length),
  ...payload,
];
const text = (field: number, value: string) => bytes(field, [...new TextEncoder().encode(value)]);
const group = (type: number, tokens: number, children: ReadonlyArray<number> = []) =>
  bytes(1, [...int(2, type), ...int(4, tokens), ...children]);

describe("antigravityBreakdownFromGeneration", () => {
  it("folds the call's token groups into messages, skills, and system", () => {
    const groups = [
      ...group(1, 4_000, bytes(5, [...text(1, "skills"), ...int(3, 1_000)])),
      ...group(2, 5_000),
      ...group(
        7,
        13_000,
        bytes(5, [...text(1, "0: USER_INPUT"), ...int(3, 400)]).concat(
          bytes(5, [...text(1, "1: RUN_COMMAND"), ...int(3, 12_600)]),
        ),
      ),
    ];
    const generation = bytes(1, bytes(9, bytes(10, bytes(3, groups))));
    expect(antigravityBreakdownFromGeneration(Uint8Array.from(generation))).toEqual({
      usedTokens: 22_000,
      breakdown: [
        { category: "messages", tokens: 13_000 },
        { category: "skills", tokens: 1_000 },
        { category: "system", tokens: 8_000 },
      ],
    });
  });

  it.effect(
    "reads newest context and turn generations from the selected store and rejects unsafe paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        for (const appDataDirectory of ["antigravity-cli", "antigravity-acp", "custom-cli"]) {
          const conversations = path.join(root, appDataDirectory, "conversations");
          yield* fs.makeDirectory(conversations, { recursive: true });
          const connection = new NodeSqlite.DatabaseSync(path.join(conversations, "session.db"));
          try {
            connection.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
            connection.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER)");
            connection.exec("INSERT INTO steps VALUES (7, 23)");
            const insert = connection.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
            const generation = (output: number, input: number, context: number) =>
              Uint8Array.from([
                ...text(4, "native-execution"),
                ...bytes(1, [
                  ...bytes(4, [...int(2, input), ...int(3, output), ...int(5, 100), ...int(9, 10)]),
                  ...bytes(9, bytes(10, bytes(3, group(7, context)))),
                ]),
              ]);
            insert.run(0, generation(900, 800, 99));
            insert.run(1, generation(20, 30, 500));
            insert.run(2, Uint8Array.from([...bytes(2, [7]), ...generation(1000, 2000, 500)]));
            insert.run(3, Uint8Array.from(bytes(7, [])));
            insert.run(4, generation(30, 40, 500));
          } finally {
            connection.close();
          }
          const read = (id: string, app = appDataDirectory) =>
            readAntigravityContextUsage(root, id, app);
          const sessionUsage = yield* read("session");
          expect(sessionUsage).toMatchObject({ usedTokens: 500 });
          expect(sessionUsage).not.toHaveProperty("maxTokens");
          // A turn starts after generation 0; checkpoint and injected generations are not replies.
          const current = yield* readAntigravityContextUsage(root, "session", appDataDirectory, 0);
          expect(current?.generationUsage).toMatchObject({
            latestId: 4,
            latestExecutionId: "native-execution",
            generations: [
              { id: 0, usage: { outputTokens: 900 } },
              {
                id: 1,
                executionId: "native-execution",
                usage: { outputTokens: 20, inputTokens: 130, reasoningTokens: 10 },
              },
              { id: 4, usage: { outputTokens: 30 } },
            ],
          });
          expect(yield* readAntigravityContextUsage(root, "session", appDataDirectory, 0)).toEqual(
            current,
          );
          const update = new NodeSqlite.DatabaseSync(path.join(conversations, "session.db"));
          try {
            update
              .prepare("UPDATE gen_metadata SET data = ? WHERE idx = 4")
              .run(Uint8Array.from(bytes(1, bytes(4, int(3, 35)))));
          } finally {
            update.close();
          }
          const revised = yield* readAntigravityContextUsage(root, "session", appDataDirectory, 4);
          expect(revised?.generationUsage.generations).toMatchObject([
            { id: 4, usage: { outputTokens: 35 } },
          ]);
          const child = new NodeSqlite.DatabaseSync(path.join(conversations, "child.db"));
          try {
            child.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
            child.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER)");
            child
              .prepare("INSERT INTO gen_metadata VALUES (0, ?)")
              .run(Uint8Array.from(bytes(1, bytes(4, int(3, 99999)))));
          } finally {
            child.close();
          }
          expect(yield* readAntigravityContextUsage(root, "session", appDataDirectory, 4)).toEqual(
            revised,
          );
          expect(yield* read("../session")).toBeUndefined();
          expect(yield* read("missing")).toMatchObject({
            usedTokens: 0,
            generationUsage: { latestId: -1 },
          });
          expect(yield* read("session", "../antigravity-cli")).toBeUndefined();
          if (symlinksSupported) {
            yield* fs.symlink(
              path.join(conversations, "session.db"),
              path.join(conversations, "linked.db"),
            );
            expect(yield* read("linked")).toBeUndefined();
            yield* fs.rename(conversations, `${conversations}-real`);
            yield* fs.symlink(`${conversations}-real`, conversations);
            expect(yield* read("session")).toBeUndefined();
          }
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("uses the 1.5.7 context groups rather than billing input or output tokens", () => {
    // Numeric fields from a 1.5.7 ACP generation, with all prompt content omitted.
    const generation = bytes(1, [
      ...bytes(4, [...int(2, 9_032), ...int(3, 690), ...int(9, 544)]),
      ...bytes(
        9,
        bytes(10, [
          ...int(1, 12_977),
          ...int(4, 256_000),
          ...bytes(3, [...group(1, 6_402), ...group(2, 6_331), ...group(7, 244)]),
        ]),
      ),
    ]);
    expect(antigravityBreakdownFromGeneration(Uint8Array.from(generation))).toEqual({
      usedTokens: 12_977,
      maxTokens: 256_000,
      breakdown: [
        { category: "messages", tokens: 244 },
        { category: "skills", tokens: 0 },
        { category: "system", tokens: 12_733 },
      ],
    });
    expect(antigravityUsageFromGeneration(Uint8Array.from(generation))).toMatchObject({
      inputTokens: 9_032,
      outputTokens: 690,
      reasoningTokens: 544,
      usageStatus: "partial",
    });
    expect(antigravityUsageFromGeneration(Uint8Array.from(bytes(1, bytes(9, []))))).toBeUndefined();
  });
});
