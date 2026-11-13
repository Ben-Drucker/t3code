import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { tokenThroughput } from "./tokenThroughput";

it("weights chat throughput by duration and selects the latest measured turn", () => {
  const sample = (start: number, end: number, outputTokens: number) => ({
    startedAt: DateTime.makeUnsafe(start),
    completedAt: DateTime.makeUnsafe(end),
    turnTokenUsage: {
      usageScope: "main_agent" as const,
      usageStatus: "complete" as const,
      hasSubagents: false,
      inputTokens: 100,
      outputTokens,
    },
  });
  expect(tokenThroughput([sample(1000, 4000, 90), sample(0, 1000, 10)])).toEqual({
    average: 25,
    last: 30,
  });
  expect(
    tokenThroughput([sample(0, 0, 100), { ...sample(0, 1000, 100), turnTokenUsage: undefined }]),
  ).toEqual({ average: null, last: null });
  expect(
    tokenThroughput([
      {
        ...sample(0, 1000, 100),
        turnTokenUsage: { ...sample(0, 1000, 100).turnTokenUsage, localCommand: true },
      },
    ]),
  ).toEqual({ average: null, last: null });
});
