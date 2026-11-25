import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { summarizeContext } from "./handlers.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const projection = (fields: {
  turns?: ReadonlyArray<Record<string, unknown>>;
  items?: ReadonlyArray<Record<string, unknown>>;
  options?: ReadonlyArray<{ id: string; value: string }>;
}) =>
  ({
    thread: {
      id: "thread-1",
      activeProviderThreadId: "pt-2",
      modelSelection: { instanceId: "claudeAgent", model: "opus", options: fields.options ?? [] },
    },
    providerThreads: [{ id: "pt-2", contextUsage: null, updatedAt: at("2026-11-24T00:00:00Z") }],
    providerTurns: fields.turns ?? [],
    turnItems: fields.items ?? [],
  }) as never;

const usage = (providerThreadId: string, usedTokens: number, updatedAt: string) => ({
  providerThreadId,
  tokenUsage: { usedTokens, maxTokens: 400_000, autoCompactThreshold: 300_000, updatedAt },
});

const compaction = (providerThreadId: string, completedAt: string, afterTokenCount?: number) => ({
  type: "compaction",
  status: "completed",
  providerThreadId,
  completedAt: at(completedAt),
  updatedAt: at(completedAt),
  ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
});

describe("summarizeContext", () => {
  it("reports the active provider thread's newest usage and tokens left before compaction", () => {
    const summary = summarizeContext(
      projection({
        turns: [
          usage("pt-1", 390_000, "2026-11-24T03:00:00Z"),
          usage("pt-2", 100_000, "2026-11-24T01:00:00Z"),
          usage("pt-2", 120_000, "2026-11-24T02:00:00Z"),
        ],
        options: [
          { id: "contextLimit", value: "400000" },
          { id: "compactBuffer", value: "25" },
        ],
      }),
    );
    expect(summary).toMatchObject({
      usedTokens: 120_000,
      maxTokens: 400_000,
      usedPercent: 30,
      autoCompactThreshold: 300_000,
      tokensUntilCompaction: 180_000,
      compactionCount: 0,
      contextLimitSetting: 400_000,
      compactBufferPercentSetting: 25,
    });
  });

  it("counts every completed compaction and uses a newer compaction's token count", () => {
    const summary = summarizeContext(
      projection({
        turns: [usage("pt-2", 280_000, "2026-11-24T01:00:00Z")],
        items: [
          compaction("pt-1", "2026-11-23T00:00:00Z", 10_000),
          compaction("pt-2", "2026-11-24T02:00:00Z", 40_000),
          { ...compaction("pt-2", "2026-11-24T03:00:00Z"), status: "running" },
        ],
      }),
    );
    expect(summary).toMatchObject({
      usedTokens: 40_000,
      maxTokens: 400_000,
      tokensUntilCompaction: 260_000,
      compactionCount: 2,
    });
  });

  it("returns nulls before any usage is reported", () => {
    expect(summarizeContext(projection({}))).toMatchObject({
      usedTokens: null,
      maxTokens: null,
      tokensUntilCompaction: null,
      compactionCount: 0,
      updatedAt: null,
    });
  });
});
