import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { parseAgentConfigChip, parseAgentToolChip } from "@t3tools/shared/composerInlineTokens";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "./providerIconUtils";

/** What a chip needs from the provider catalog. */
export type ChipCatalogEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "customIconUrl"
  | "models"
>;

export type ParsedAgentModelChip = NonNullable<ReturnType<typeof parseAgentConfigChip>>;
export type ParsedAgentToolChip = NonNullable<ReturnType<typeof parseAgentToolChip>>;

export type AgentConfigSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "model"; readonly raw: string; readonly chip: ParsedAgentModelChip }
  | { readonly type: "tool"; readonly raw: string; readonly chip: ParsedAgentToolChip };

const SPLIT_CACHE_LIMIT = 256;
const SPLIT_CACHE_MAX_TEXT_LENGTH = 16_384;
const splitCache = new Map<string, ReadonlyArray<AgentConfigSegment>>();

function scanAgentConfigText(text: string): AgentConfigSegment[] {
  if (text.length === 0) return [];
  let searchFrom = text.indexOf("%[");
  if (searchFrom === -1) return [{ type: "text", text }];

  const segments: AgentConfigSegment[] = [];
  let cursor = 0;

  while (searchFrom !== -1) {
    const innerStart = searchFrom + 2;
    const isTool = text.startsWith("tool: ", innerStart);
    const isModel = !isTool && text.startsWith("model: ", innerStart);
    if (!isTool && !isModel) {
      searchFrom = text.indexOf("%[", innerStart);
      continue;
    }

    const closeIndex = text.indexOf("]", innerStart);
    if (closeIndex === -1) break;

    const inner = text.slice(innerStart, closeIndex);
    if (inner.includes("\n") || inner.includes("\r") || inner.includes("[")) {
      searchFrom = text.indexOf("%[", innerStart);
      continue;
    }

    const tool = isTool ? parseAgentToolChip(inner) : null;
    const model = isModel ? parseAgentConfigChip(inner) : null;
    if (!tool && !model) {
      searchFrom = text.indexOf("%[", closeIndex + 1);
      continue;
    }

    if (searchFrom > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, searchFrom) });
    }
    const raw = text.slice(searchFrom, closeIndex + 1);
    if (tool) {
      segments.push({ type: "tool", raw, chip: tool });
    } else if (model) {
      segments.push({ type: "model", raw, chip: model });
    }
    cursor = closeIndex + 1;
    searchFrom = text.indexOf("%[", cursor);
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
  return segments;
}

/** Plain runs and well-formed `%[...]` chips in order. A malformed `%[` stays plain text. */
export function splitAgentConfigText(text: string): ReadonlyArray<AgentConfigSegment> {
  if (text.length === 0) return [];
  if (!text.includes("%[")) return [{ type: "text", text }];
  if (text.length > SPLIT_CACHE_MAX_TEXT_LENGTH) return scanAgentConfigText(text);

  const cached = splitCache.get(text);
  if (cached !== undefined) {
    splitCache.delete(text);
    splitCache.set(text, cached);
    return cached;
  }

  const segments = scanAgentConfigText(text);
  splitCache.set(text, segments);
  if (splitCache.size > SPLIT_CACHE_LIMIT) {
    const oldest = splitCache.keys().next().value;
    if (oldest !== undefined) splitCache.delete(oldest);
  }
  return segments;
}

export type ModelChipView =
  | {
      readonly kind: "model";
      readonly entry: ChipCatalogEntry;
      readonly modelLabel: string;
      readonly badges: ReadonlyArray<string>;
    }
  | { readonly kind: "raw"; readonly text: string };

/** The human chip for a model choice, or the raw `instance/model` text when the catalog lacks it. */
export function modelChipView(
  chip: ParsedAgentModelChip,
  entries: ReadonlyArray<ChipCatalogEntry>,
): ModelChipView {
  const entry = entries.find((candidate) => candidate.instanceId === chip.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === chip.model);
  if (!entry || !model) return { kind: "raw", text: `${chip.instanceId}/${chip.model}` };
  return {
    kind: "model",
    entry,
    modelLabel: getTriggerDisplayModelName(model, entry.driverKind),
    badges: chipBadges(model, chip.options),
  };
}

const BADGE_RANK = { reasoning: 0, fast: 1, contextLimit: 2, compactBuffer: 3 } as const;

/**
 * Badges for the options that differ from the model's defaults, in the order the picker reads
 * them: reasoning level, Fast, context limit, buffer. Defaults come from the catalog, not the chip.
 */
export function chipBadges(
  model: ServerProviderModel,
  options: ReadonlyArray<{ readonly id: string; readonly value: string }>,
): ReadonlyArray<string> {
  const caps = model.capabilities;
  if (!caps) return [];
  const defaults = getProviderOptionDescriptors({ caps });
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: options.map((option) => {
      const kind = defaults.find((descriptor) => descriptor.id === option.id)?.type;
      return { id: option.id, value: kind === "boolean" ? option.value === "true" : option.value };
    }),
  });
  const badges: Array<{ readonly rank: number; readonly text: string }> = [];
  for (const option of options) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    const fallback = defaults.find((candidate) => candidate.id === option.id);
    if (!descriptor || !fallback) continue;
    if (descriptor.type === "boolean") {
      const on = descriptor.currentValue === true;
      const defaultOn = fallback.type === "boolean" && fallback.currentValue === true;
      if (on && !defaultOn && /fast/iu.test(descriptor.id)) {
        badges.push({ rank: BADGE_RANK.fast, text: "Fast" });
      }
      continue;
    }
    const defaultValue =
      fallback.type === "select"
        ? (fallback.currentValue ?? fallback.options.find((item) => item.isDefault)?.id)
        : undefined;
    if (option.value === defaultValue) continue;
    if (option.id === "contextLimit") {
      const limit = Number(option.value);
      if (limit > 0) {
        badges.push({ rank: BADGE_RANK.contextLimit, text: formatContextWindowTokens(limit) });
      }
    } else if (option.id === "compactBuffer") {
      badges.push({ rank: BADGE_RANK.compactBuffer, text: `${option.value}% free` });
    } else if (descriptor.type === "select" && descriptor.role === "reasoning") {
      const label = descriptor.options.find((item) => item.id === option.value)?.label;
      badges.push({ rank: BADGE_RANK.reasoning, text: label ?? option.value });
    }
  }
  return badges.toSorted((left, right) => left.rank - right.rank).map((badge) => badge.text);
}

export type ToolSourceKind =
  | { readonly kind: "t3" }
  | { readonly kind: "provider"; readonly driverKind: ProviderDriverKind }
  | { readonly kind: "mcp" };

const PROVIDER_SOURCE_DRIVER: Readonly<Record<string, ProviderDriverKind>> = {
  Claude: ProviderDriverKind.make("claudeAgent"),
  Codex: ProviderDriverKind.make("codex"),
};

/** Sources are named by the composer menu: `T3`, a provider name, or a configured MCP server. */
export function toolSourceKind(source: string): ToolSourceKind {
  if (source === "T3") return { kind: "t3" };
  const driverKind = PROVIDER_SOURCE_DRIVER[source];
  return driverKind ? { kind: "provider", driverKind } : { kind: "mcp" };
}

/** The readable form of a chip for plain-text surfaces such as search snippets. */
export function agentConfigPlainText(
  text: string,
  entries: ReadonlyArray<ChipCatalogEntry>,
): string {
  return splitAgentConfigText(text)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      if (segment.type === "tool") return `${segment.chip.source} › ${segment.chip.tool}`;
      const view = modelChipView(segment.chip, entries);
      if (view.kind === "raw") return view.text;
      return [view.modelLabel, ...view.badges].join(" · ");
    })
    .join("");
}
