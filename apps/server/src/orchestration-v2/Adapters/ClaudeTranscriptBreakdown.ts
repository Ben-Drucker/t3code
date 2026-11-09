import type { ThreadContextBreakdown } from "@t3tools/contracts";

type Breakdown = typeof ThreadContextBreakdown.Type;

// Rough size of text in tokens; the transcript carries no per-block counts.
const CHARS_PER_TOKEN = 3.7;

const tokensOf = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length / CHARS_PER_TOKEN;
};

interface TranscriptEntry {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly isSidechain?: unknown;
  readonly isMeta?: unknown;
  readonly message?: { readonly content?: unknown };
}

const isSkillBody = (text: string) => text.startsWith("Base directory for this skill:");

/**
 * Splits what a Claude transcript says is in the window into reasoning, messages and skills.
 * Whatever the provider's own total leaves over is the system prompt and tool definitions,
 * which the transcript never records. Only the part after the latest compaction counts, and
 * only reasoning from the turn in progress, since earlier thinking is not sent back.
 */
export function claudeTranscriptBreakdown(
  lines: Iterable<string>,
  usedTokens: number,
): Breakdown | undefined {
  if (usedTokens <= 0) return undefined;
  let messages = 0;
  let skills = 0;
  let turnReasoning = 0;
  let sawEntry = false;
  const skillCalls = new Set<string>();
  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      messages = 0;
      skills = 0;
      turnReasoning = 0;
      skillCalls.clear();
      continue;
    }
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isSidechain === true) {
      continue;
    }
    const content = entry.message?.content;
    const blocks: ReadonlyArray<unknown> =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? content
          : [];
    let startsTurn = entry.type === "user";
    for (const raw of blocks) {
      const block = raw as Record<string, unknown>;
      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? block.text : "";
          if (
            entry.type === "user" &&
            (entry.isMeta === true || isSkillBody(text)) &&
            isSkillBody(text)
          ) {
            skills += tokensOf(text);
          } else {
            messages += tokensOf(text);
          }
          break;
        }
        case "thinking":
          turnReasoning += tokensOf(block.thinking);
          break;
        case "tool_use": {
          const bucket = block.name === "Skill" ? "skills" : "messages";
          if (bucket === "skills" && typeof block.id === "string") skillCalls.add(block.id);
          const size = tokensOf(block.input) + tokensOf(block.name);
          if (bucket === "skills") skills += size;
          else messages += size;
          break;
        }
        case "tool_result": {
          startsTurn = false;
          const size = tokensOf(block.content);
          if (typeof block.tool_use_id === "string" && skillCalls.has(block.tool_use_id)) {
            skills += size;
          } else {
            messages += size;
          }
          break;
        }
        default:
          break;
      }
    }
    // A real user message ends the previous turn; its thinking is no longer sent.
    if (startsTurn && blocks.some((raw) => (raw as { type?: unknown }).type === "text")) {
      turnReasoning = 0;
    }
    sawEntry = true;
  }
  if (!sawEntry) return undefined;
  const reasoning = turnReasoning;
  const counted = messages + skills + reasoning;
  // Estimates can overshoot the measured total; shrink them to fit, leaving no system share.
  const scale = counted > usedTokens ? usedTokens / counted : 1;
  const parts = {
    reasoning: Math.round(reasoning * scale),
    messages: Math.round(messages * scale),
    skills: Math.round(skills * scale),
  };
  const system = Math.max(0, usedTokens - parts.reasoning - parts.messages - parts.skills);
  return [
    { category: "reasoning", tokens: parts.reasoning },
    { category: "messages", tokens: parts.messages },
    { category: "skills", tokens: parts.skills },
    { category: "system", tokens: system },
  ];
}
