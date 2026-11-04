import { describe, expect, it } from "vite-plus/test";

import { estimateContextBreakdown, resolveContextBreakdown } from "./contextBreakdown";

const entry = (item: Record<string, unknown>) => ({ item }) as never;

describe("estimateContextBreakdown", () => {
  it("assigns the unexplained remainder to tools and system", () => {
    const result = estimateContextBreakdown({
      entries: [],
      messageChars: 7400,
      usedTokens: 10_000,
    });
    const byCategory = Object.fromEntries(result.categories.map((c) => [c.category, c.tokens]));
    expect(byCategory.messages).toBe(2000);
    expect(byCategory.system).toBe(8000);
    expect(result.estimated).toBe(true);
  });

  it("counts skill reads as skills and prefers reported reasoning", () => {
    const result = estimateContextBreakdown({
      entries: [
        entry({ type: "dynamic_tool", toolName: "Skill", input: {}, output: "z".repeat(370) }),
      ],
      messageChars: 0,
      usedTokens: 5_000,
      reportedReasoningTokens: 700,
    });
    const byCategory = Object.fromEntries(result.categories.map((c) => [c.category, c.tokens]));
    expect(byCategory.skills).toBeGreaterThanOrEqual(100);
    expect(byCategory.reasoning).toBe(700);
  });

  it("drops everything before the last compaction", () => {
    const result = estimateContextBreakdown({
      entries: [entry({ type: "compaction", summary: "s".repeat(370) })],
      messageChars: 0,
      usedTokens: 4_000,
    });
    expect(result.categories.find((c) => c.category === "messages")?.tokens).toBe(100);
  });

  it("never exceeds the reported total", () => {
    const result = estimateContextBreakdown({
      entries: [],
      messageChars: 100_000,
      usedTokens: 1_000,
    });
    expect(result.categories.reduce((sum, c) => sum + c.tokens, 0)).toBeLessThanOrEqual(1_000);
  });
});

describe("resolveContextBreakdown", () => {
  it("uses a provider-reported split as is", () => {
    const result = resolveContextBreakdown({
      reported: [
        { category: "messages", tokens: 10 },
        { category: "system", tokens: 5 },
      ],
      entries: [],
      messageChars: 0,
      usedTokens: 15,
    });
    expect(result.estimated).toBe(false);
    expect(result.categories.find((c) => c.category === "system")?.tokens).toBe(5);
  });
});
