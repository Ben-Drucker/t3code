import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type Sample = Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt" | "turnTokenUsage">;

export function tokenThroughput(turns: readonly Sample[]) {
  let tokens = 0;
  let seconds = 0;
  let last: number | null = null;
  let lastCompleted = -Infinity;
  for (const turn of turns) {
    const usage = turn.turnTokenUsage;
    if (
      !turn.startedAt ||
      !turn.completedAt ||
      usage?.usageStatus !== "complete" ||
      usage.localCommand
    )
      continue;
    const completed = DateTime.toEpochMillis(turn.completedAt);
    const duration = (completed - DateTime.toEpochMillis(turn.startedAt)) / 1000;
    if (duration <= 0) continue;
    tokens += usage.outputTokens;
    seconds += duration;
    if (completed >= lastCompleted) {
      last = usage.outputTokens / duration;
      lastCompleted = completed;
    }
  }
  return { average: seconds > 0 ? tokens / seconds : null, last };
}
