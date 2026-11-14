import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { tokenThroughput } from "./tokenThroughput.ts";

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
    tokenThroughput([
      sample(0, 1000, 10),
      { ...sample(1000, 4000, 90), turnTokenUsage: undefined },
    ]),
  ).toEqual({ average: 10, last: null });
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
  const live = {
    ...sample(10_000, 12_000, 40),
    completedAt: null,
    tokenUsage: { updatedAt: "1970-01-01T00:00:12.000Z" },
    turnTokenUsage: { ...sample(0, 1, 40).turnTokenUsage, usageStatus: "partial" as const },
  };
  expect(tokenThroughput([sample(0, 1000, 10), live])).toEqual({ average: 50 / 3, last: 20 });
  const nextStep = {
    ...live,
    tokenUsage: { updatedAt: "1970-01-01T00:00:14.000Z" },
    turnTokenUsage: { ...live.turnTokenUsage, outputTokens: 120 },
  };
  expect(tokenThroughput([sample(0, 1000, 10), nextStep])).toEqual({ average: 26, last: 30 });
  const finished = { ...nextStep, completedAt: DateTime.makeUnsafe(16_000) };
  expect(tokenThroughput([sample(0, 1000, 10), finished])).toEqual({ average: 130 / 7, last: 20 });
  expect(
    tokenThroughput([
      {
        ...finished,
        tokenUsage: { updatedAt: "1970-01-02T00:00:00.000Z" },
      },
    ]),
  ).toEqual({ average: 20, last: 20 });
  expect(
    tokenThroughput([
      {
        ...live,
        tokenUsage: undefined,
        turnTokenUsage: { ...live.turnTokenUsage, updatedAt: "1970-01-01T00:00:12.000Z" },
      },
    ]),
  ).toEqual({ average: 20, last: 20 });
  expect(
    tokenThroughput([
      sample(0, 1000, 10),
      {
        ...nextStep,
        turnTokenUsage: { ...nextStep.turnTokenUsage, localCommand: true },
      },
    ]),
  ).toEqual({ average: 10, last: 10 });
  expect(tokenThroughput([sample(0, 1000, 10), { ...live, turnTokenUsage: undefined }])).toEqual({
    average: 10,
    last: null,
  });
  expect(tokenThroughput([{ ...live, tokenUsage: { updatedAt: "invalid" } }])).toEqual({
    average: null,
    last: null,
  });
});
