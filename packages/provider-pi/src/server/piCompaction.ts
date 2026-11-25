import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

const CONTEXT_LIMIT_OPTION = "contextLimit";
const COMPACT_BUFFER_OPTION = "compactBuffer";

const CONTEXT_LIMITS = [100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000];
const COMPACT_BUFFER_PERCENTS = [5, 10, 15, 20, 25, 30, 40];
/** Pi's own default `compaction.reserveTokens`. */
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

const formatTokens = (tokens: number) =>
  tokens >= 1_000_000 ? `${Math.round(tokens / 10_000) / 100}M` : `${Math.round(tokens / 1000)}K`;

const readNumber = (selection: ModelSelection | undefined, id: string) => {
  const value = Number(getModelSelectionStringOptionValue(selection, id));
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * What the meter measures against, and the token count where Pi should compact. Null threshold
 * means the thread chose neither control and Pi's own `contextWindow - reserveTokens` stands.
 */
export function resolvePiCompaction(
  selection: ModelSelection | undefined,
  window: number | null,
): { readonly maxTokens: number | null; readonly threshold: number | null } {
  const limit = readNumber(selection, CONTEXT_LIMIT_OPTION);
  const bufferPercent = readNumber(selection, COMPACT_BUFFER_OPTION);
  const maxTokens = limit === null ? window : Math.min(limit, window ?? limit);
  if (maxTokens === null || (limit === null && bufferPercent === null)) {
    return { maxTokens, threshold: null };
  }
  const buffer =
    bufferPercent === null
      ? Math.min(PI_DEFAULT_RESERVE_TOKENS, Math.round(maxTokens / 2))
      : Math.round((maxTokens * bufferPercent) / 100);
  return { maxTokens, threshold: Math.max(1, maxTokens - buffer) };
}

/** Limits up to the model's own window, topped by the window itself. */
export function withPiContextControls(
  capabilities: ModelCapabilities,
  window: number | undefined,
): ModelCapabilities {
  if (window === undefined || window <= 0) return capabilities;
  return {
    ...capabilities,
    optionDescriptors: [
      ...(capabilities.optionDescriptors ?? []),
      {
        id: CONTEXT_LIMIT_OPTION,
        label: "Context limit",
        type: "select",
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
        options: [
          {
            id: "default",
            label: "Default",
            isDefault: true,
            description: "Pi's own: 16K free",
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

/** A Pi model record's positive `contextWindow`. */
export function piModelContextWindow(model: unknown): number | undefined {
  if (typeof model !== "object" || model === null) return undefined;
  const value = (model as { readonly contextWindow?: unknown }).contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
