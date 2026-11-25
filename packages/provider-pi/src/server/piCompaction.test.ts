import { describe, expect, it } from "vite-plus/test";

import { resolvePiCompaction, withPiContextControls } from "./piCompaction.ts";

const selection = (options: Record<string, string>) =>
  ({
    instanceId: "pi",
    model: "openrouter/z-ai/glm-5.3",
    options: Object.entries(options).map(([id, value]) => ({ id, value })),
  }) as never;

describe("resolvePiCompaction", () => {
  it("leaves Pi's own threshold when the thread chose neither control", () => {
    expect(resolvePiCompaction(selection({}), 200_000)).toEqual({
      maxTokens: 200_000,
      threshold: null,
    });
  });

  it("compacts a chosen limit at its buffer, capped by the model's window", () => {
    expect(
      resolvePiCompaction(selection({ contextLimit: "150000", compactBuffer: "20" }), 200_000),
    ).toEqual({ maxTokens: 150_000, threshold: 120_000 });
    expect(resolvePiCompaction(selection({ contextLimit: "500000" }), 200_000)).toEqual({
      maxTokens: 200_000,
      threshold: 200_000 - 16_384,
    });
  });

  it("applies a buffer alone to the model's window", () => {
    expect(resolvePiCompaction(selection({ compactBuffer: "25" }), 400_000)).toEqual({
      maxTokens: 400_000,
      threshold: 300_000,
    });
  });
});

describe("withPiContextControls", () => {
  it("offers limits below the window, the window itself, and buffers", () => {
    const capabilities = withPiContextControls({ optionDescriptors: [] } as never, 256_000);
    const [limit, buffer] = capabilities.optionDescriptors ?? [];
    expect(limit?.id).toBe("contextLimit");
    expect(limit?.type === "select" && limit.options.map((option) => option.id)).toEqual([
      "default",
      "100000",
      "150000",
      "200000",
      "250000",
      "256000",
    ]);
    expect(buffer?.id).toBe("compactBuffer");
  });

  it("adds nothing without a known window", () => {
    const capabilities = { optionDescriptors: [] } as never;
    expect(withPiContextControls(capabilities, undefined)).toBe(capabilities);
  });
});
