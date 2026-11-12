import type { ModelSelection } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { formatTokens } from "@t3tools/shared/usageFormat";

export interface AntigravityContextReading {
  readonly sessionId: string;
  readonly modelSelection: ModelSelection;
  readonly usedTokens: number | undefined;
  readonly maxTokens?: number;
  readonly reset?: boolean;
}

export function observeAntigravityContextUsage(
  previous: AntigravityContextReading | undefined,
  current: AntigravityContextReading,
): {
  readonly reading: AntigravityContextReading | undefined;
  readonly compaction?: {
    readonly beforeTokenCount: number;
    readonly afterTokenCount: number;
    readonly summary: string;
  };
} {
  const comparable =
    previous !== undefined &&
    !current.reset &&
    previous.sessionId === current.sessionId &&
    modelSelectionsEqual(previous.modelSelection, current.modelSelection) &&
    (previous.maxTokens === undefined ||
      current.maxTokens === undefined ||
      previous.maxTokens === current.maxTokens);
  const used = current.usedTokens;
  if (used === undefined || !Number.isSafeInteger(used) || used <= 0) {
    return { reading: comparable ? previous : undefined };
  }
  const before = comparable ? previous.usedTokens : undefined;
  if (before === undefined || used > before / 2) return { reading: current };
  return {
    reading: current,
    compaction: {
      beforeTokenCount: before,
      afterTokenCount: used,
      summary: `Context compacted (detected): ${formatTokens(before)} → ${formatTokens(used)} tokens, saved ${formatTokens(before - used)}`,
    },
  };
}
