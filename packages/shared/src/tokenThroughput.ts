import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type Sample = Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt" | "turnTokenUsage"> & {
  readonly tokenUsage?:
    | Pick<NonNullable<OrchestrationV2ProviderTurn["tokenUsage"]>, "updatedAt">
    | undefined;
};

export function tokenThroughput(turns: readonly Sample[]) {
  let tokens = 0;
  let seconds = 0;
  let last: number | null = null;
  let lastStarted = -Infinity;
  for (const turn of turns) {
    const usage = turn.turnTokenUsage;
    if (!turn.startedAt || usage?.localCommand) continue;
    const started = DateTime.toEpochMillis(turn.startedAt);
    // Live rates advance on measured usage events; completed rates never depend on the clock.
    const measured = turn.completedAt
      ? DateTime.toEpochMillis(turn.completedAt)
      : Date.parse(usage?.updatedAt ?? turn.tokenUsage?.updatedAt ?? "");
    const duration = (measured - started) / 1000;
    const output = usage?.usageStatus === "unavailable" ? undefined : usage?.outputTokens;
    const rate =
      Number.isFinite(duration) && duration > 0 && output !== undefined ? output / duration : null;
    if (rate !== null && output !== undefined) {
      tokens += output;
      seconds += duration;
    }
    if (started >= lastStarted) {
      last = rate;
      lastStarted = started;
    }
  }
  return { average: seconds > 0 ? tokens / seconds : null, last };
}
