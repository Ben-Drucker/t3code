import type { ComposerToolEntry, ComposerToolGroup } from "@t3tools/contracts";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

export type AgentToolSection = {
  /** Stable key, also the menu item id of the section header. */
  readonly id: string;
  readonly group: ComposerToolGroup;
  /** The tools to list under the header: every tool, or only the matches while filtering. */
  readonly tools: ReadonlyArray<ComposerToolEntry>;
  readonly expanded: boolean;
  /** Lower is better; 0 when nothing is being filtered. */
  readonly score: number;
};

/** A description match ranks below a match on the `source > tool` label. */
const DESCRIPTION_MATCH_PENALTY = 500;

export function agentToolSectionId(source: string): string {
  return `agent-section:${JSON.stringify(source)}`;
}

function normalizeLabelWords(value: string): string {
  return normalizeSearchQuery(
    value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_>./-]+/gu, " "),
  );
}

function singleQueryScore(value: string, needle: string): number | null {
  const raw = scoreQueryMatch({
    value: normalizeSearchQuery(value),
    query: needle,
    exactBase: 0,
    prefixBase: 2,
    boundaryBase: 4,
    includesBase: 6,
    ...(needle.length >= 3 ? { fuzzyBase: 100 } : {}),
    ignorePosition: true,
  });
  const wordNormalized = normalizeLabelWords(value);
  const wordScore =
    wordNormalized === normalizeSearchQuery(value)
      ? null
      : scoreQueryMatch({
          value: wordNormalized,
          query: needle,
          exactBase: 0,
          prefixBase: 2,
          boundaryBase: 4,
          includesBase: 6,
          ...(needle.length >= 3 ? { fuzzyBase: 100 } : {}),
          ignorePosition: true,
        });
  if (raw === null) return wordScore;
  return wordScore === null ? raw : Math.min(raw, wordScore);
}

function matchScore(value: string, needle: string): number | null {
  const direct = singleQueryScore(value, needle);
  const terms = needle.split(" ").filter(Boolean);
  if (terms.length <= 1) return direct;
  let total = 0;
  for (const term of terms) {
    const score = singleQueryScore(value, term);
    if (score === null) return direct;
    total += score;
  }
  const multiScore = Math.round(total / terms.length) + 1;
  return direct === null ? multiScore : Math.min(direct, multiScore);
}

export function matchesAgentModelRow(query: string): boolean {
  const needle = normalizeSearchQuery(query);
  if (needle === "") return true;
  return (
    matchScore("Model", needle) !== null ||
    matchScore("Agent configuration Model Choose a model and its options", needle) !== null
  );
}

function toolScore(
  group: ComposerToolGroup,
  tool: ComposerToolEntry,
  needle: string,
): number | null {
  const labelText = `${group.source} > ${tool.name}`;
  const label = matchScore(labelText, needle);
  const description = tool.description === null ? null : matchScore(tool.description, needle);
  const descriptionScore = description === null ? null : description + DESCRIPTION_MATCH_PENALTY;
  const bestSingleField =
    label === null
      ? descriptionScore
      : descriptionScore === null
        ? label
        : Math.min(label, descriptionScore);

  const terms = needle.split(" ").filter(Boolean);
  if (terms.length <= 1 || tool.description === null) {
    return bestSingleField;
  }
  let total = 0;
  let usedDescription = false;
  for (const term of terms) {
    const termLabel = singleQueryScore(labelText, term);
    if (termLabel !== null) {
      total += termLabel;
      continue;
    }
    const termDesc = singleQueryScore(tool.description, term);
    if (termDesc === null) {
      return bestSingleField;
    }
    usedDescription = true;
    total += termDesc;
  }
  const crossFieldScore =
    Math.round(total / terms.length) + 1 + (usedDescription ? DESCRIPTION_MATCH_PENALTY : 0);
  return bestSingleField === null ? crossFieldScore : Math.min(bestSingleField, crossFieldScore);
}

const SECTION_KIND_ORDER: Record<ComposerToolGroup["kind"], number> = {
  t3: 0,
  provider: 1,
  mcp: 2,
};

/**
 * Sections for the `%` menu. Unfiltered: T3, then provider sources in the order the server
 * reports them, then MCP servers by name. Filtered: only sections with a match, best match first.
 * A section is open when the user opened it, T3 starts open, and every matching section is open
 * while filtering. `overrides` holds the user's open or closed choices by section id.
 */
export function buildAgentToolSections(
  groups: ReadonlyArray<ComposerToolGroup>,
  query: string,
  overrides: ReadonlyMap<string, boolean>,
): AgentToolSection[] {
  const needle = normalizeSearchQuery(query);
  const sections: Array<AgentToolSection & { readonly order: number }> = [];
  groups.forEach((group, order) => {
    const id = agentToolSectionId(group.source);
    if (needle === "") {
      sections.push({
        id,
        group,
        tools: group.tools,
        expanded: overrides.get(id) ?? group.kind === "t3",
        score: 0,
        order,
      });
      return;
    }
    const headerScore = matchScore(group.source, needle);
    const matched = group.tools
      .map((tool) => ({ tool, score: toolScore(group, tool, needle) }))
      .filter((match): match is { tool: ComposerToolEntry; score: number } => match.score !== null);
    const hasNoTools = group.tools.length === 0;
    if (matched.length === 0 && !(hasNoTools && headerScore !== null)) return;
    const scores = [
      ...matched.map((match) => match.score),
      ...(headerScore === null ? [] : [headerScore]),
    ];
    sections.push({
      id,
      group,
      tools: matched.toSorted((left, right) => left.score - right.score).map((match) => match.tool),
      expanded: true,
      score: Math.min(...scores),
      order,
    });
  });
  const kindOrder = (section: { readonly group: ComposerToolGroup }) =>
    SECTION_KIND_ORDER[section.group.kind];
  return sections
    .toSorted((left, right) => {
      if (needle !== "") return left.score - right.score || left.order - right.order;
      return (
        kindOrder(left) - kindOrder(right) ||
        (left.group.kind === "mcp" ? left.group.source.localeCompare(right.group.source) : 0) ||
        left.order - right.order
      );
    })
    .map(({ order: _order, ...section }) => section);
}
