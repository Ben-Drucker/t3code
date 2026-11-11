import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

const CONTEXT_LIMIT_OPTION = "contextLimit";
const COMPACT_BUFFER_OPTION = "compactBuffer";

const CONTEXT_LIMITS = [100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000];
const COMPACT_BUFFER_PERCENTS = [5, 10, 15, 20, 25, 30, 40];
/** OpenCode's own buffer: 15% of the window, at least 16K. */
const DEFAULT_BUFFER_PERCENT = 15;
const MIN_BUFFER_TOKENS = 16_000;

const formatTokens = (tokens: number) =>
  tokens >= 1_000_000 ? `${Math.round(tokens / 10_000) / 100}M` : `${Math.round(tokens / 1000)}K`;

const readNumber = (selection: ModelSelection | undefined, id: string) => {
  const value = Number(getModelSelectionStringOptionValue(selection, id));
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * What the meter measures against, and where T3 starts a compaction. OpenCode's own thresholds are
 * server-wide, so T3 compacts a session itself once it reaches `threshold`. Null means the
 * thread chose neither control and OpenCode's own behavior stands.
 */
export function resolveOpenCodeCompaction(
  selection: ModelSelection | undefined,
  window: number | undefined,
): { readonly maxTokens: number | null; readonly threshold: number | null } {
  const limit = readNumber(selection, CONTEXT_LIMIT_OPTION);
  const bufferPercent = readNumber(selection, COMPACT_BUFFER_OPTION);
  const maxTokens = limit === null ? (window ?? null) : Math.min(limit, window ?? limit);
  if (maxTokens === null || (limit === null && bufferPercent === null)) {
    return { maxTokens, threshold: null };
  }
  const buffer =
    bufferPercent === null
      ? Math.max(MIN_BUFFER_TOKENS, Math.round((maxTokens * DEFAULT_BUFFER_PERCENT) / 100))
      : Math.round((maxTokens * bufferPercent) / 100);
  return { maxTokens, threshold: Math.max(1, maxTokens - buffer) };
}

/** Limits up to the model's own window, topped by the window itself. */
export function withOpenCodeContextControls(
  capabilities: ModelCapabilities,
  window: number | undefined,
): ModelCapabilities {
  if (window === undefined) return capabilities;
  return {
    ...capabilities,
    optionDescriptors: [
      ...(capabilities.optionDescriptors ?? []),
      {
        id: CONTEXT_LIMIT_OPTION,
        label: "Context limit",
        type: "select",
        lockedOnceStarted: true,
        options: [
          {
            id: "default",
            label: "Default",
            isDefault: true,
            description: `Currently ${formatTokens(window)}`,
          },
          ...[...CONTEXT_LIMITS.filter((tokens) => tokens < window), window].map((tokens) => ({
            id: String(tokens),
            label: formatTokens(tokens),
          })),
        ],
      },
      {
        id: COMPACT_BUFFER_OPTION,
        label: "Compaction buffer",
        type: "select",
        lockedOnceStarted: true,
        options: [
          {
            id: "default",
            label: "Default",
            isDefault: true,
            description: "OpenCode's own: 15% free",
          },
          ...COMPACT_BUFFER_PERCENTS.map((percent) => ({
            id: String(percent),
            label: `${percent}% free`,
          })),
        ],
      },
    ],
  };
}
