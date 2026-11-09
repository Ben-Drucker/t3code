import { describe, expect, it } from "vite-plus/test";

import { estimateKimiBreakdown } from "./kimiBreakdown.ts";

const loop = (event: unknown) => JSON.stringify({ type: "context.append_loop_event", event });
const chars = (count: number) => "x".repeat(count);

describe("estimateKimiBreakdown", () => {
  it("sizes reasoning, messages and skills and leaves the rest to system", () => {
    const breakdown = estimateKimiBreakdown(
      [
        JSON.stringify({ type: "turn.prompt" }),
        JSON.stringify({
          type: "context.append_message",
          message: { content: [{ type: "text", text: chars(3700) }] },
        }),
        loop({ type: "content.part", part: { type: "think", think: chars(3700) } }),
        loop({ type: "tool.call", toolCallId: "a", name: "Skill", args: { name: "s" } }),
        loop({ type: "tool.result", toolCallId: "a", result: { output: chars(7400) } }),
        loop({ type: "tool.result", toolCallId: "b", result: { output: chars(3700) } }),
      ],
      20_000,
    );
    const tokens = (category: string) =>
      breakdown?.find((row) => row.category === category)?.tokens;
    expect(tokens("reasoning")).toBe(1000);
    expect(tokens("skills")).toBeGreaterThan(1990);
    expect(tokens("messages")).toBeGreaterThan(1990);
    expect(breakdown?.reduce((sum, row) => sum + row.tokens, 0)).toBe(20_000);
  });
});
