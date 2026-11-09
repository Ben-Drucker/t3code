/**
 * Fork: Kimi Code reports only a total, so the split is estimated from the wire log. Reasoning,
 * messages and skills are sized from their text; the rest of the measured total is the system
 * prompt and tool definitions, which the log keeps only as a hash.
 */
const CHARS_PER_TOKEN = 3.7;

export interface KimiContextBreakdown {
  readonly category: "reasoning" | "messages" | "skills" | "system";
  readonly tokens: number;
}

const sizeOf = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length / CHARS_PER_TOKEN;
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

const isSkillCall = (name: unknown, args: unknown) =>
  name === "Skill" || JSON.stringify(args ?? "").includes("SKILL.md");

export function estimateKimiBreakdown(
  lines: Iterable<string>,
  usedTokens: number,
): ReadonlyArray<KimiContextBreakdown> | undefined {
  if (usedTokens <= 0) return undefined;
  let messages = 0;
  let skills = 0;
  let reasoning = 0;
  let sawEntry = false;
  const skillCalls = new Set<string>();
  for (const line of lines) {
    let entry: Readonly<Record<string, unknown>>;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry.type === "turn.prompt" || entry.type === "context.append_message") {
      // A new turn: earlier reasoning is no longer sent back.
      if (entry.type === "context.append_message") {
        messages += sizeOf(record(entry.message).content);
        sawEntry = true;
      }
      if (entry.type === "turn.prompt") reasoning = 0;
      continue;
    }
    if (entry.type !== "context.append_loop_event") continue;
    const event = record(entry.event);
    sawEntry = true;
    switch (event.type) {
      case "content.part": {
        const part = record(event.part);
        if (part.type === "think") reasoning += sizeOf(part.think);
        else messages += sizeOf(part.text ?? part);
        break;
      }
      case "tool.call": {
        const size = sizeOf(event.name) + sizeOf(event.args);
        if (isSkillCall(event.name, event.args) && typeof event.toolCallId === "string") {
          skillCalls.add(event.toolCallId);
          skills += size;
        } else {
          messages += size;
        }
        break;
      }
      case "tool.result": {
        const size = sizeOf(record(event.result).output);
        if (typeof event.toolCallId === "string" && skillCalls.has(event.toolCallId)) {
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
  if (!sawEntry) return undefined;
  const counted = messages + skills + reasoning;
  const scale = counted > usedTokens ? usedTokens / counted : 1;
  const parts = {
    reasoning: Math.round(reasoning * scale),
    messages: Math.round(messages * scale),
    skills: Math.round(skills * scale),
  };
  return [
    { category: "reasoning", tokens: parts.reasoning },
    { category: "messages", tokens: parts.messages },
    { category: "skills", tokens: parts.skills },
    {
      category: "system",
      tokens: Math.max(0, usedTokens - parts.reasoning - parts.messages - parts.skills),
    },
  ];
}
