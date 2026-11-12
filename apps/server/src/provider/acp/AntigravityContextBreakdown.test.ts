import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  antigravityBreakdownFromGeneration,
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
    "reads only the newest generation from the selected store and rejects unsafe native paths",
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
            const insert = connection.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
            insert.run(0, Uint8Array.from(bytes(1, bytes(9, bytes(10, bytes(3, group(7, 99)))))));
            insert.run(1, Uint8Array.from(bytes(1, bytes(9, bytes(10, bytes(3, group(7, 500)))))));
          } finally {
            connection.close();
          }
          const read = (id: string, app = appDataDirectory) =>
            readAntigravityContextUsage(root, id, app);
          expect(yield* read("session")).toMatchObject({ usedTokens: 500, maxTokens: 256_000 });
          expect(yield* read("../session")).toBeUndefined();
          expect(yield* read("missing")).toBeUndefined();
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
      breakdown: [
        { category: "messages", tokens: 244 },
        { category: "skills", tokens: 0 },
        { category: "system", tokens: 12_733 },
      ],
    });
  });
});
