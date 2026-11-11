import { expect, it } from "vite-plus/test";
import type { ModelSelection } from "@t3tools/contracts";
import { resolveOpenCodeCompaction } from "./openCodeCompaction.ts";

const select = (options: Record<string, string>) =>
  ({
    instanceId: "opencode",
    model: "openai/gpt-6",
    options: Object.entries(options).map(([id, value]) => ({ id, value })),
  }) as unknown as ModelSelection;

it.each([
  {
    name: "defaults leave OpenCode alone",
    options: {},
    window: 400_000,
    expected: { maxTokens: 400_000, threshold: null },
  },
  {
    name: "limit uses OpenCode's own buffer",
    options: { contextLimit: "200000" },
    window: 400_000,
    expected: { maxTokens: 200_000, threshold: 170_000 },
  },
  {
    name: "limit and buffer",
    options: { contextLimit: "200000", compactBuffer: "20" },
    window: 400_000,
    expected: { maxTokens: 200_000, threshold: 160_000 },
  },
  {
    name: "buffer against the model window",
    options: { compactBuffer: "10" },
    window: 400_000,
    expected: { maxTokens: 400_000, threshold: 360_000 },
  },
  {
    name: "a limit above the window is capped",
    options: { contextLimit: "750000" },
    window: 400_000,
    expected: { maxTokens: 400_000, threshold: 340_000 },
  },
  {
    name: "unknown window",
    options: { compactBuffer: "10" },
    window: undefined,
    expected: { maxTokens: null, threshold: null },
  },
])("$name", ({ options, window, expected }) => {
  expect(resolveOpenCodeCompaction(select(options), window)).toEqual(expected);
});
