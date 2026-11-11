import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { getDescriptorStringValue } from "@t3tools/client-runtime/model-traits";
import { createContext, useContext } from "react";
import { formatContextWindowTokens } from "../../lib/contextWindow";

/** The thread's current context limit in tokens, so pickers can show what a choice leaves free. */
const ComposerContextLimitContext = createContext<number | null>(null);

export const ComposerContextLimitProvider = ComposerContextLimitContext.Provider;
export const useComposerContextLimit = () => useContext(ComposerContextLimitContext);

/** Whether the thread has turns, which fixes options an agent reads only when it launches. */
const ComposerThreadStartedContext = createContext(false);

export const ComposerThreadStartedProvider = ComposerThreadStartedContext.Provider;
export const useComposerThreadStarted = () => useContext(ComposerThreadStartedContext);

/** Claude compacts this far short of its window unless a buffer is chosen. */
const DEFAULT_COMPACT_RESERVE_TOKENS = 33_000;

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** The numeric limit picked in the limit control, or null when it is left on Default. */
export function chosenContextLimit(descriptors: ReadonlyArray<SelectDescriptor>): number | null {
  const chosen = Number(
    getDescriptorStringValue(descriptors.find((d) => d.id === "contextLimit") ?? null),
  );
  return chosen > 0 ? chosen : null;
}

/** What a choice means in tokens, against the limit being chosen or else the thread's current one. */
export function contextControlReadout(
  descriptorId: string,
  optionId: string,
  chosenLimit: number | null,
  currentLimit: number | null,
) {
  const limit = chosenLimit ?? currentLimit;
  if (descriptorId === "contextLimit")
    return optionId === "default" && limit
      ? `Currently ${formatContextWindowTokens(limit)}`
      : undefined;
  if (descriptorId !== "compactBuffer" || !limit) return undefined;
  const free =
    optionId === "default"
      ? DEFAULT_COMPACT_RESERVE_TOKENS
      : Math.round((limit * Number(optionId)) / 100);
  if (!(free > 0)) return undefined;
  const percent = Math.round((free / limit) * 100);
  const detail =
    optionId === "default" ? ` (${formatContextWindowTokens(free)}, ${percent}% free)` : "";
  return `Compacts at ~${formatContextWindowTokens(limit - free)}${detail}`;
}
