import { describe, expect, it } from "vite-plus/test";

import { claudeContextUsageReport } from "./ClaudeAdapterV2.ts";

describe("claudeContextUsageReport", () => {
  it("folds Claude's rows into messages, skills, and tools/system and skips free space", () => {
    const report = claudeContextUsageReport({
      categories: [
        { name: "Messages", tokens: 52_000, kind: "used" },
        { name: "MCP tools", tokens: 16_200, kind: "used" },
        { name: "System prompt", tokens: 11_000, kind: "used" },
        { name: "Skills", tokens: 7_200, kind: "used" },
        { name: "Memory files", tokens: 2_600, kind: "used" },
        { name: "Since last update", tokens: 71_900, kind: "used" },
        { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        { name: "Free space", tokens: 133_100, kind: "free" },
        { name: "MCP tools (deferred)", tokens: 106_200, kind: "deferred" },
      ],
    });
    expect(report.breakdown).toEqual([
      { category: "messages", tokens: 123_900 },
      { category: "skills", tokens: 7_200 },
      { category: "system", tokens: 29_800 },
    ]);
    expect(report.usedTokens).toBe(160_900);
  });
});
