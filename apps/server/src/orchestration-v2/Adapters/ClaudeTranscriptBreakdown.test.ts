import { describe, expect, it } from "vite-plus/test";

import { claudeTranscriptBreakdown } from "./ClaudeTranscriptBreakdown.ts";

const line = (value: unknown) => JSON.stringify(value);
const text = (chars: number) => "x".repeat(chars);

describe("claudeTranscriptBreakdown", () => {
  it("splits reasoning, messages and skills, and leaves the rest to system", () => {
    const breakdown = claudeTranscriptBreakdown(
      [
        line({ type: "user", message: { content: text(3700) } }),
        line({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: text(3700) },
              { type: "tool_use", id: "s1", name: "Skill", input: { skill: "big-picture" } },
            ],
          },
        }),
        line({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "s1", content: text(7400) }] },
        }),
      ],
      20_000,
    );
    expect(breakdown).toEqual([
      { category: "reasoning", tokens: 1000 },
      { category: "messages", tokens: 1000 },
      { category: "skills", tokens: expect.closeTo(2000, -2) },
      { category: "system", tokens: expect.closeTo(16_000, -2) },
    ]);
  });

  it("drops what a compaction replaced and thinking from earlier turns", () => {
    const breakdown = claudeTranscriptBreakdown(
      [
        line({ type: "user", message: { content: text(37_000) } }),
        line({ type: "system", subtype: "compact_boundary" }),
        line({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: text(3700) }] },
        }),
        line({ type: "user", message: { content: text(370) } }),
      ],
      10_000,
    );
    expect(breakdown?.find((row) => row.category === "reasoning")?.tokens).toBe(0);
    expect(breakdown?.find((row) => row.category === "messages")?.tokens).toBe(100);
  });
});
