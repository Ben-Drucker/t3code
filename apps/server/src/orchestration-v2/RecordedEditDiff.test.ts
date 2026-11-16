import { NodeId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { recordedEditDiff } from "./RecordedEditDiff.ts";

const base = {
  id: TurnItemId.make("item-1"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: NodeId.make("node-1"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00.000Z"),
  type: "file_change" as const,
  fileName: "src/main.ts",
};

describe("recordedEditDiff", () => {
  it("computes additions for write-only newStr without oldStr or changes", () => {
    const result = recordedEditDiff({
      ...base,
      newStr: "const a = 1;\nconst b = 2;\n",
    });
    expect(result).toMatchObject({ additions: 2, deletions: 0 });
  });

  it("computes additions for create operation without oldStr", () => {
    const result = recordedEditDiff({
      ...base,
      newStr: "line1\nline2\nline3\n",
      changes: [{ path: "src/main.ts", operation: "create" }],
    });
    expect(result).toMatchObject({
      additions: 3,
      deletions: 0,
      changes: [{ path: "src/main.ts", operation: "create", additions: 3, deletions: 0 }],
    });
  });

  it("parses raw hunk diffStr without file headers and populates single-change stats", () => {
    const result = recordedEditDiff({
      ...base,
      diffStr: "@@ -1,2 +1,3 @@\n keep\n-old\n+new1\n+new2\n",
      changes: [{ path: "src/main.ts", operation: "update" }],
    });
    expect(result).toMatchObject({
      additions: 2,
      deletions: 1,
      changes: [{ path: "src/main.ts", operation: "update", additions: 2, deletions: 1 }],
    });
  });

  it("matches relative diff headers to absolute change paths in multi-file diffs", () => {
    const result = recordedEditDiff({
      ...base,
      fileName: "/workspace/src/a.ts",
      diffStr: [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        "-a",
        "+a1",
        "+a2",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1,2 +1 @@",
        "-b1",
        "-b2",
        "+b",
      ].join("\n"),
      changes: [
        { path: "/workspace/src/a.ts", operation: "update" },
        { path: "/workspace/src/b.ts", operation: "update" },
      ],
    });
    expect(result).toMatchObject({
      additions: 3,
      deletions: 3,
      changes: [
        { path: "/workspace/src/a.ts", operation: "update", additions: 2, deletions: 1 },
        { path: "/workspace/src/b.ts", operation: "update", additions: 1, deletions: 2 },
      ],
    });
  });

  it("sums per-change additions and deletions when diffStr is omitted", () => {
    const result = recordedEditDiff({
      ...base,
      changes: [
        { path: "src/a.ts", operation: "add", additions: 4, deletions: 0 },
        { path: "src/b.ts", operation: "update", additions: 2, deletions: 3 },
      ],
    });
    expect(result).toMatchObject({ additions: 6, deletions: 3 });
  });
});
