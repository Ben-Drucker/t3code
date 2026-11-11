import type { ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export const CODEX_CONTEXT_LIMIT_OPTION = "contextLimit";
export const CODEX_COMPACT_BUFFER_OPTION = "compactBuffer";

/** Codex reports 95% of the configured `model_context_window` as the usable window. */
const CODEX_USABLE_WINDOW_SHARE = 0.95;

const readNumber = (selection: ModelSelection | undefined, id: string) => {
  const value = Number(getModelSelectionStringOptionValue(selection, id));
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * Codex config for a thread's chosen limit and buffer. `knownWindow` is the usable window Codex
 * last reported; the buffer needs it when no limit is chosen. Empty when both are left on Default.
 */
export function resolveCodexContextConfig(
  selection: ModelSelection | undefined,
  knownWindow: number | null,
): Readonly<Record<string, number>> {
  const limit = readNumber(selection, CODEX_CONTEXT_LIMIT_OPTION);
  const bufferPercent = readNumber(selection, CODEX_COMPACT_BUFFER_OPTION);
  const usable = limit ?? knownWindow;
  return {
    ...(limit === null
      ? {}
      : { model_context_window: Math.round(limit / CODEX_USABLE_WINDOW_SHARE) }),
    ...(bufferPercent === null || usable === null
      ? {}
      : { model_auto_compact_token_limit: Math.round(usable * (1 - bufferPercent / 100)) }),
  };
}
