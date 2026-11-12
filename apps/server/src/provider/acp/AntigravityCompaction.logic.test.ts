import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  observeAntigravityContextUsage,
  type AntigravityContextReading,
} from "./AntigravityCompaction.logic.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("antigravity"), model: "hydrogen" };
const reading = (
  usedTokens: number | undefined,
  overrides: Partial<AntigravityContextReading> = {},
): AntigravityContextReading => ({
  sessionId: "native-session",
  modelSelection,
  usedTokens,
  ...overrides,
});

describe("Antigravity context compaction detection", () => {
  it.each([
    { name: "exactly 50%", readings: [reading(400_000), reading(200_000)], count: 1 },
    { name: "more than 50%", readings: [reading(412_000), reading(96_000)], count: 1 },
    { name: "49%", readings: [reading(400_000), reading(204_000)], count: 0 },
    { name: "first reading", readings: [reading(96_000)], count: 0 },
    {
      name: "different session",
      readings: [reading(412_000), reading(96_000, { sessionId: "new-session" })],
      count: 0,
    },
    {
      name: "model change",
      readings: [
        reading(412_000),
        reading(96_000, { modelSelection: { ...modelSelection, model: "carbon" } }),
      ],
      count: 0,
    },
    {
      name: "context option change",
      readings: [
        reading(412_000),
        reading(96_000, {
          modelSelection: { ...modelSelection, options: [{ id: "contextLimit", value: "256000" }] },
        }),
      ],
      count: 0,
    },
    {
      name: "context window change",
      readings: [
        reading(412_000, { maxTokens: 1_048_576 }),
        reading(96_000, { maxTokens: 256_000 }),
      ],
      count: 0,
    },
    {
      name: "resume/load/rewind/fork",
      readings: [reading(412_000), reading(96_000, { reset: true })],
      count: 0,
    },
    { name: "zero reading", readings: [reading(412_000), reading(0)], count: 0 },
    { name: "unknown reading", readings: [reading(412_000), reading(undefined)], count: 0 },
    { name: "invalid reading", readings: [reading(412_000), reading(Number.NaN)], count: 0 },
    {
      name: "duplicate drop",
      readings: [reading(412_000), reading(96_000), reading(96_000)],
      count: 1,
    },
    {
      name: "last accepted reading",
      readings: [reading(412_000), reading(0), reading(undefined), reading(96_000)],
      count: 1,
    },
    {
      name: "consecutive small drops",
      readings: [reading(400_000), reading(300_000), reading(200_000)],
      count: 0,
    },
    {
      name: "another compaction later",
      readings: [reading(412_000), reading(96_000), reading(400_000), reading(100_000)],
      count: 2,
    },
  ])("$name", ({ readings, count }) => {
    let previous: AntigravityContextReading | undefined;
    const compactions = [];
    for (const current of readings) {
      const observed = observeAntigravityContextUsage(previous, current);
      previous = observed.reading;
      if (observed.compaction) compactions.push(observed.compaction);
    }
    expect(compactions).toHaveLength(count);
    if (readings[0]?.usedTokens === 412_000 && count > 0) {
      expect(compactions[0]).toEqual({
        beforeTokenCount: 412_000,
        afterTokenCount: 96_000,
        summary: "Context compacted (detected): 412K → 96K tokens, saved 316K",
      });
    }
  });
});
