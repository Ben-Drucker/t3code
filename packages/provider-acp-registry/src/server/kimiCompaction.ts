import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

const KIMI_CONTEXT_LIMIT_OPTION = "contextLimit";
const KIMI_COMPACT_BUFFER_OPTION = "compactBuffer";

/** Kimi compacts this far short of its window when `reserved_context_size` is not configured. */
export const KIMI_DEFAULT_RESERVED_TOKENS = 50_000;

const CONTEXT_LIMITS = [100_000, 150_000, 200_000, 250_000, 300_000, 375_000];
const COMPACT_BUFFER_PERCENTS = [5, 10, 15, 20, 25, 30, 40];

const readNumber = (selection: ModelSelection | undefined, id: string) => {
  const value = Number(getModelSelectionStringOptionValue(selection, id));
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** `reserved_context_size` from the `[loop_control]` table of Kimi's config.toml, if set. */
export function parseKimiReservedTokens(configText: string): number | undefined {
  let inLoopControl = false;
  for (const line of configText.split("\n")) {
    if (/^\s*\[/.test(line)) inLoopControl = /^\s*\[loop_control\]\s*$/.test(line);
    else if (inLoopControl) {
      const match = /^\s*reserved_context_size\s*=\s*(\d+)/.exec(line);
      if (match !== null) return Number(match[1]);
    }
  }
  return undefined;
}

/** The limit chosen for the thread, or null when it is left on Default. */
export const kimiChosenLimit = (selection: ModelSelection | undefined) =>
  readNumber(selection, KIMI_CONTEXT_LIMIT_OPTION);

/**
 * Kimi compacts at its window minus `reserved_context_size`, and reads the window from
 * `KIMI_MODEL_MAX_CONTEXT_SIZE` when it launches. A buffer of N% free is that window raised by the
 * reserve, so compaction lands at the limit less N%.
 */
export function kimiLaunchEnvironment(
  selection: ModelSelection | undefined,
  reservedTokens: number,
): Readonly<Record<string, string>> {
  const limit = kimiChosenLimit(selection);
  const bufferPercent = readNumber(selection, KIMI_COMPACT_BUFFER_OPTION);
  if (limit === null) return {};
  const window =
    bufferPercent === null ? limit : Math.round(limit * (1 - bufferPercent / 100)) + reservedTokens;
  return { KIMI_MODEL_MAX_CONTEXT_SIZE: String(window) };
}

/** Appends the context controls, which only take effect when the thread's Kimi process launches. */
export function withKimiContextControls(capabilities: ModelCapabilities): ModelCapabilities {
  const descriptors = capabilities.optionDescriptors ?? [];
  if (descriptors.some((descriptor) => descriptor.id === KIMI_CONTEXT_LIMIT_OPTION))
    return capabilities;
  return {
    ...capabilities,
    optionDescriptors: [
      ...descriptors,
      {
        id: KIMI_CONTEXT_LIMIT_OPTION,
        label: "Context limit",
        type: "select",
        lockedOnceStarted: true,
        options: [
          { id: "default", label: "Default", isDefault: true },
          ...CONTEXT_LIMITS.map((tokens) => ({
            id: String(tokens),
            label: `${tokens / 1000}K`,
          })),
        ],
      },
      {
        id: KIMI_COMPACT_BUFFER_OPTION,
        label: "Compaction buffer",
        type: "select",
        lockedOnceStarted: true,
        options: [
          { id: "default", label: "Default", isDefault: true, description: "Kimi's own reserve" },
          ...COMPACT_BUFFER_PERCENTS.map((percent) => ({
            id: String(percent),
            label: `${percent}% free`,
          })),
        ],
      },
    ],
  };
}
