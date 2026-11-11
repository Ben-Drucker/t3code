import type { ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

/** Claude compacts this many tokens short of its auto-compact window (Claude Code 2.1.305). */
export const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;
/** Claude ignores a configured window below this. */
const CLAUDE_MIN_AUTO_COMPACT_WINDOW = 100_000;
const FALLBACK_WINDOW_TOKENS = 1_000_000;

export const CLAUDE_CONTEXT_LIMIT_OPTION = "contextLimit";
export const CLAUDE_COMPACT_BUFFER_OPTION = "compactBuffer";

export interface ClaudeCompaction {
  /** What the meter measures against. */
  readonly maxTokens: number;
  /** The auto-compact window to give Claude, or null to leave Claude's own. */
  readonly window: number | null;
  readonly autoCompactThreshold: number | null;
}

/**
 * `limit` caps how much context the thread may use; `bufferPercent` is the share of that limit kept
 * free before Claude compacts. Either may be absent, in which case `baseWindow` (Claude's own
 * configured window) and Claude's default reserve apply.
 */
export function resolveClaudeCompaction(input: {
  readonly limit: number | null;
  readonly bufferPercent: number | null;
  readonly baseWindow: number | null;
  readonly catalogTokens: number | null;
}): ClaudeCompaction {
  const cap = input.catalogTokens ?? FALLBACK_WINDOW_TOKENS;
  const limit = Math.min(input.limit ?? input.baseWindow ?? cap, cap);
  const target =
    input.bufferPercent === null
      ? limit
      : Math.round(limit * (1 - input.bufferPercent / 100)) + CLAUDE_AUTO_COMPACT_RESERVE_TOKENS;
  const window = Math.min(Math.max(target, CLAUDE_MIN_AUTO_COMPACT_WINDOW), cap);
  return {
    maxTokens: limit,
    window: window >= cap && input.bufferPercent === null ? null : window,
    autoCompactThreshold:
      window >= cap && input.bufferPercent === null
        ? null
        : window - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS,
  };
}

/** The thread's own choices, or null for each one left on its default. */
export function claudeSelectedCompaction(selection: ModelSelection | undefined) {
  const read = (id: string) => {
    const value = Number(getModelSelectionStringOptionValue(selection, id));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    limit: read(CLAUDE_CONTEXT_LIMIT_OPTION),
    bufferPercent: read(CLAUDE_COMPACT_BUFFER_OPTION),
  };
}
