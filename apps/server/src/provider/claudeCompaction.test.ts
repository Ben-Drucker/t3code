import { expect, it } from "vite-plus/test";

import { resolveClaudeCompaction } from "./claudeCompaction.ts";

const catalogTokens = 1_000_000;

it.each([
  // Nothing chosen: Claude's own window.
  [{ limit: null, bufferPercent: null, baseWindow: null }, 1_000_000, null, null],
  // A limit alone compacts 33K short of it, like Claude's own window setting.
  [{ limit: 375_000, bufferPercent: null, baseWindow: null }, 375_000, 375_000, 342_000],
  // The configured window stays the limit when only a buffer is chosen.
  [{ limit: null, bufferPercent: 10, baseWindow: 375_000 }, 375_000, 370_500, 337_500],
  // Limit and buffer: compact when 20% of 500K is left.
  [{ limit: 500_000, bufferPercent: 20, baseWindow: 375_000 }, 500_000, 433_000, 400_000],
  // Claude never takes a window under 100K, so a large buffer on a small limit stops there.
  [{ limit: 150_000, bufferPercent: 60, baseWindow: null }, 150_000, 100_000, 67_000],
  // A limit above the model's window is the model's window.
  [{ limit: 2_000_000, bufferPercent: null, baseWindow: null }, 1_000_000, null, null],
])("compacts for %j", (input, maxTokens, window, autoCompactThreshold) => {
  expect(resolveClaudeCompaction({ ...input, catalogTokens })).toEqual({
    maxTokens,
    window,
    autoCompactThreshold,
  });
});
