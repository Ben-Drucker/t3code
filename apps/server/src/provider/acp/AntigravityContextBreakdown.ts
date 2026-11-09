// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session log.
import * as NodeSqlite from "node:sqlite";

import type { ThreadContextBreakdown } from "@t3tools/contracts";

type Breakdown = typeof ThreadContextBreakdown.Type;
import * as Effect from "effect/Effect";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

/**
 * Fork: Antigravity records a token breakdown with every model call in the `gen_metadata` table of
 * the session database. This follows the accounting of the `agy /context` command, as ported by
 * https://github.com/dimitr-io/antigravity-desktop-context, and folds its rows into our four.
 */

class Proto {
  private readonly fields = new Map<number, Array<number | Uint8Array>>();

  constructor(buffer: Uint8Array | undefined) {
    const bytes = buffer ?? new Uint8Array();
    let position = 0;
    const varint = () => {
      let value = 0n;
      let shift = 0n;
      while (position < bytes.length) {
        const byte = bytes[position++]!;
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value;
        shift += 7n;
      }
      throw new RangeError("truncated varint");
    };
    try {
      while (position < bytes.length) {
        const tag = Number(varint());
        const field = tag >> 3;
        const wire = tag & 7;
        let value: number | Uint8Array;
        if (wire === 0) {
          // Negative int32 values arrive as 64-bit two's complement.
          const raw = varint();
          value = Number(BigInt.asIntN(64, raw));
        } else if (wire === 2) {
          const length = Number(varint());
          value = bytes.subarray(position, position + length);
          position += length;
        } else if (wire === 1) {
          position += 8;
          continue;
        } else if (wire === 5) {
          position += 4;
          continue;
        } else {
          break;
        }
        const existing = this.fields.get(field);
        if (existing === undefined) this.fields.set(field, [value]);
        else existing.push(value);
      }
    } catch {
      // A truncated tail keeps what decoded before it.
    }
  }

  int(field: number): number {
    const value = this.fields.get(field)?.at(-1);
    return typeof value === "number" ? value : 0;
  }

  string(field: number): string {
    const value = this.fields.get(field)?.at(-1);
    return value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
  }

  message(field: number): Proto | undefined {
    const value = this.fields.get(field)?.at(-1);
    return value instanceof Uint8Array ? new Proto(value) : undefined;
  }

  messages(field: number): ReadonlyArray<Proto> {
    return (this.fields.get(field) ?? []).flatMap((value) =>
      value instanceof Uint8Array ? [new Proto(value)] : [],
    );
  }
}

// Token groups in the call's breakdown (agy 1.4 `cli/model.ContextModel`).
const GROUP = {
  systemPrompt: 1,
  tools: 2,
  rules: 3,
  mcpTools: 4,
  skills: 5,
  subagents: 6,
  chatMessages: 7,
  workflows: 8,
  plugins: 9,
  flows: 10,
} as const;

export function antigravityBreakdownFromGeneration(
  generation: Uint8Array,
): { readonly usedTokens: number; readonly breakdown: Breakdown } | undefined {
  const chat = new Proto(generation).message(1);
  const groups = chat?.message(9)?.message(10)?.message(3)?.messages(1);
  if (groups === undefined) return undefined;
  let messages = 0;
  let skills = 0;
  let system = 0;
  let chatTokens = 0;
  let chatItems: ReadonlyArray<Proto> = [];
  let sawPromptOrTools = false;
  for (const group of groups) {
    const type = group.int(2);
    const tokens = group.int(4);
    switch (type) {
      case GROUP.systemPrompt: {
        let extracted = 0;
        for (const child of group.messages(5)) {
          const name = child.string(1);
          if (name === "skills") skills += child.int(3);
          else if (name === "flows" || name === "subagents") system += child.int(3);
          else continue;
          extracted += child.int(3);
        }
        system += tokens - extracted;
        sawPromptOrTools = true;
        break;
      }
      case GROUP.tools:
        system += tokens;
        sawPromptOrTools = true;
        break;
      case GROUP.skills:
        skills += tokens;
        break;
      case GROUP.chatMessages:
        chatTokens = tokens;
        chatItems = group.messages(5);
        break;
      case GROUP.rules:
      case GROUP.mcpTools:
      case GROUP.subagents:
      case GROUP.workflows:
      case GROUP.plugins:
      case GROUP.flows:
        system += tokens;
        break;
      default:
        break;
    }
  }
  messages = chatTokens;
  // Without a system prompt group, the API input beyond the chat is overhead.
  if (!sawPromptOrTools && chatTokens > 0) {
    const usage = chat?.message(4);
    const apiInput = usage === undefined ? 0 : usage.int(2) + usage.int(5);
    if (chatTokens < apiInput) system += apiInput - chatTokens;
  }
  // System-type chat rows belong to the system share, not the conversation.
  for (const item of chatItems) {
    const [, label = ""] = item.string(1).split(": ");
    if (label === "SYSTEM_MESSAGE" || label === "FINISH" || label === "UNSPECIFIED") {
      system += item.int(3);
      messages -= item.int(3);
    }
  }
  messages = Math.max(0, messages);
  const usedTokens = messages + skills + system;
  if (usedTokens <= 0) return undefined;
  return {
    usedTokens,
    breakdown: [
      { category: "messages", tokens: messages },
      { category: "skills", tokens: skills },
      { category: "system", tokens: system },
    ],
  };
}

const NATIVE_SESSION_ID = /^[\w-]+$/;

/** The newest breakdown in this session's own database, or undefined. Never fails. */
export const readAntigravityContextUsage = (profileDirectory: string, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!NATIVE_SESSION_ID.test(sessionId)) return undefined;
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      const database = await antigravityManagedPath(
        root,
        ["antigravity-acp", "conversations", `${sessionId}.db`],
        "file",
      );
      if (database === undefined) return undefined;
      const connection = new NodeSqlite.DatabaseSync(database.path, { readOnly: true });
      try {
        connection.exec("PRAGMA busy_timeout = 100");
        const row = connection
          .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1")
          .get();
        return row?.data instanceof Uint8Array
          ? antigravityBreakdownFromGeneration(row.data)
          : undefined;
      } finally {
        connection.close();
      }
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
