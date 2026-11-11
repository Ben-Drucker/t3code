import { describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "@t3tools/contracts";
import { resolveCodexContextConfig } from "./codexCompaction.ts";

const select = (options: Record<string, string>) =>
  ({
    instanceId: "codex",
    model: "gpt-6-luna",
    options: Object.entries(options).map(([id, value]) => ({ id, value })),
  }) as unknown as ModelSelection;

describe("resolveCodexContextConfig", () => {
  it.each([
    { name: "defaults", options: {}, known: 272_000, expected: {} },
    {
      name: "limit only",
      options: { contextLimit: "200000" },
      known: null,
      expected: { model_context_window: 210_526 },
    },
    {
      name: "limit and buffer",
      options: { contextLimit: "200000", compactBuffer: "20" },
      known: 272_000,
      expected: { model_context_window: 210_526, model_auto_compact_token_limit: 160_000 },
    },
    {
      name: "buffer against the known window",
      options: { compactBuffer: "10" },
      known: 250_000,
      expected: { model_auto_compact_token_limit: 225_000 },
    },
    {
      name: "buffer with no known window",
      options: { compactBuffer: "10" },
      known: null,
      expected: {},
    },
  ])("$name", ({ options, known, expected }) => {
    expect(resolveCodexContextConfig(select(options), known)).toEqual(expected);
  });
});
