import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

const CONTEXT_BREAKDOWN_CATEGORIES = ["reasoning", "messages", "skills", "system"] as const;
export type ContextBreakdownCategory = (typeof CONTEXT_BREAKDOWN_CATEGORIES)[number];

export interface ContextBreakdown {
  readonly categories: ReadonlyArray<{
    readonly category: ContextBreakdownCategory;
    readonly tokens: number;
  }>;
  /** True when the split is estimated from the transcript instead of reported by the provider. */
  readonly estimated: boolean;
}

export const CONTEXT_BREAKDOWN_LABELS: Record<ContextBreakdownCategory, string> = {
  reasoning: "Reasoning",
  messages: "Messages",
  skills: "Skills",
  system: "Tools & system",
};

// Prose and code average a little under four characters per token.
const CHARS_PER_TOKEN = 3.7;

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isSkillItem(item: ThreadStructureTurnItem): boolean {
  if (item.type === "dynamic_tool") {
    return (
      item.toolName?.toLowerCase() === "skill" ||
      (textLength(item.input) > 0 && JSON.stringify(item.input).includes("SKILL.md"))
    );
  }
  return item.type === "command_execution" && item.input.includes("SKILL.md");
}

/** Characters this item adds to the model's context, split into the buckets we can see. */
function measureItem(item: ThreadStructureTurnItem): {
  readonly messages: number;
  readonly skills: number;
} {
  switch (item.type) {
    // Conversation text and reasoning text stream separately from the structure, so they are
    // measured from the message list and the provider's reasoning count instead.
    case "proposed_plan":
      return { messages: item.markdown.length, skills: 0 };
    case "command_execution":
    case "dynamic_tool": {
      const chars = textLength(item.input) + textLength(item.output);
      return isSkillItem(item) ? { messages: 0, skills: chars } : { messages: chars, skills: 0 };
    }
    case "file_change":
      return {
        messages: item.diffStr?.length ?? (item.newStr?.length ?? 0) + (item.oldStr?.length ?? 0),
        skills: 0,
      };
    case "file_search":
      return {
        messages: textLength(item.pattern) + textLength(item.results),
        skills: 0,
      };
    case "web_search":
      return {
        messages: textLength(item.patterns) + textLength(item.results),
        skills: 0,
      };
    case "subagent":
      return {
        messages: item.prompt.length + (item.result?.length ?? 0),
        skills: 0,
      };
    case "user_input_request":
      return { messages: textLength(item.questions), skills: 0 };
    default:
      return { messages: 0, skills: 0 };
  }
}

/**
 * Splits used context into reasoning, messages, skills, and tools/system for providers that
 * report no split. The remainder after visible content is tools and system.
 */
export function estimateContextBreakdown(input: {
  readonly entries: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>;
  /** Characters of user and assistant message text in the thread. */
  readonly messageChars: number;
  readonly usedTokens: number;
  readonly reportedReasoningTokens?: number | null | undefined;
}): ContextBreakdown {
  // A compaction replaces everything before it with its summary.
  let startIndex = 0;
  let summaryChars = 0;
  for (let index = input.entries.length - 1; index >= 0; index -= 1) {
    const item = input.entries[index]?.item;
    if (item?.type === "compaction") {
      startIndex = index + 1;
      summaryChars = item.summary?.length ?? 0;
      break;
    }
  }

  let messageChars = input.messageChars + summaryChars;
  let skillChars = 0;
  for (let index = startIndex; index < input.entries.length; index += 1) {
    const item = input.entries[index]?.item;
    if (!item) continue;
    const measured = measureItem(item);
    messageChars += measured.messages;
    skillChars += measured.skills;
  }

  const used = Math.max(0, input.usedTokens);
  let reasoning = Math.round(input.reportedReasoningTokens ?? 0);
  let messages = Math.round(messageChars / CHARS_PER_TOKEN);
  let skills = Math.round(skillChars / CHARS_PER_TOKEN);

  // Estimates can overshoot a small window; shrink them together so the total stays honest.
  const visible = reasoning + messages + skills;
  if (visible > used && visible > 0) {
    const scale = used / visible;
    reasoning = Math.round(reasoning * scale);
    messages = Math.round(messages * scale);
    skills = Math.round(skills * scale);
  }
  const system = Math.max(0, used - reasoning - messages - skills);

  return {
    estimated: true,
    categories: [
      { category: "reasoning", tokens: reasoning },
      { category: "messages", tokens: messages },
      { category: "skills", tokens: skills },
      { category: "system", tokens: system },
    ],
  };
}

/** Prefers a split the provider reported; otherwise estimates one. */
export function resolveContextBreakdown(input: {
  readonly reported: ThreadTokenUsageSnapshot["breakdown"] | null | undefined;
  readonly entries: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>;
  readonly messageChars: number;
  readonly usedTokens: number;
  readonly reportedReasoningTokens?: number | null | undefined;
}): ContextBreakdown {
  if (input.reported && input.reported.length > 0) {
    const totals = new Map<ContextBreakdownCategory, number>();
    for (const row of input.reported) {
      totals.set(row.category, (totals.get(row.category) ?? 0) + row.tokens);
    }
    return {
      estimated: false,
      categories: CONTEXT_BREAKDOWN_CATEGORIES.map((category) => ({
        category,
        tokens: totals.get(category) ?? 0,
      })),
    };
  }
  return estimateContextBreakdown(input);
}
