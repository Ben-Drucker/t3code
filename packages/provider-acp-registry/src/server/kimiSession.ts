/**
 * Fork: live context usage for Kimi. Kimi's ACP server drops its per-step status event, but the CLI
 * appends it to its session files as it goes. UNVERIFIED layout: see docs/fork/CLOUD-HANDOFF.md.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Subagent bursts in wire.jsonl can leave 300+ KB between status events, so read a wide tail.
const TAIL_BYTES = 1024 * 1024;

type UnknownRecord = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

export const resolveKimiShareDirectory = (input: {
  readonly path: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): string =>
  input.environment.KIMI_SHARE_DIR?.trim() || input.path.join(input.homeDirectory, ".kimi");

/** Complete lines of a file tail; the first line is dropped when the tail starts mid-file. */
const tailLines = (text: string, truncated: boolean): ReadonlyArray<string> => {
  const lines = text.split("\n");
  return (truncated ? lines.slice(1) : lines).filter((line) => line.trim() !== "");
};

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** The first object under `value` that has numeric `context_tokens` or `max_context_tokens`. */
function findStatus(
  value: unknown,
  depth = 0,
): { contextTokens?: number; maxTokens?: number } | undefined {
  const record = asRecord(value);
  if (record === undefined || depth > 6) return undefined;
  const contextTokens = positiveNumber(record.context_tokens);
  const maxTokens = positiveNumber(record.max_context_tokens);
  if (contextTokens !== undefined || maxTokens !== undefined) {
    return {
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    };
  }
  for (const child of Object.values(record)) {
    const found = findStatus(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface KimiContextUsage {
  readonly usedTokens: number;
  readonly maxTokens?: number;
}

/**
 * `context.jsonl` carries `{"role":"_usage","token_count":N}` after every model step (N is the
 * current context size); `wire.jsonl` carries the status event with the window size.
 */
export function parseKimiContextUsage(input: {
  readonly contextLines: ReadonlyArray<string>;
  readonly wireLines: ReadonlyArray<string>;
}): KimiContextUsage | undefined {
  let usedTokens: number | undefined;
  for (let index = input.contextLines.length - 1; index >= 0; index -= 1) {
    const record = asRecord(parseLine(input.contextLines[index]!));
    if (record?.role === "_usage") {
      usedTokens = positiveNumber(record.token_count);
      if (usedTokens !== undefined) break;
    }
  }
  let maxTokens: number | undefined;
  let wireTokens: number | undefined;
  for (let index = input.wireLines.length - 1; index >= 0; index -= 1) {
    const status = findStatus(parseLine(input.wireLines[index]!));
    if (status === undefined) continue;
    wireTokens ??= status.contextTokens;
    maxTokens ??= status.maxTokens;
    if (wireTokens !== undefined && maxTokens !== undefined) break;
  }
  const used = usedTokens ?? wireTokens;
  if (used === undefined) return undefined;
  return { usedTokens: used, ...(maxTokens === undefined ? {} : { maxTokens }) };
}

/** Reads the newest `context.jsonl`/`wire.jsonl` lines of a Kimi session. Never fails. */
export const makeKimiContextUsageReader = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}) => {
  const { fs, path } = input;
  const sessionDirectories = new Map<string, string>();
  // The window size rarely changes; keep it for polls whose wire tail holds no status event.
  const windowSizes = new Map<string, number>();

  const locate = Effect.fnUntraced(function* (sessionId: string) {
    const cached = sessionDirectories.get(sessionId);
    if (cached !== undefined) return cached;
    const sessionsRoot = path.join(resolveKimiShareDirectory(input), "sessions");
    const buckets = yield* fs.readDirectory(sessionsRoot);
    for (const bucket of buckets) {
      const candidate = path.join(sessionsRoot, bucket, sessionId);
      if (yield* fs.exists(candidate)) {
        sessionDirectories.set(sessionId, candidate);
        return candidate;
      }
    }
    return undefined;
  });

  const readTail = Effect.fnUntraced(function* (filePath: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(filePath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - TAIL_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(Math.min(size, TAIL_BYTES));
        const text = bytes._tag === "Some" ? new TextDecoder().decode(bytes.value) : "";
        return tailLines(text, start > 0);
      }),
    );
  });

  return (request: { readonly sessionId: string }): Effect.Effect<KimiContextUsage | undefined> =>
    Effect.gen(function* () {
      const directory = yield* locate(request.sessionId);
      if (directory === undefined) return undefined;
      const contextLines = yield* readTail(path.join(directory, "context.jsonl"));
      const wireLines = yield* readTail(path.join(directory, "wire.jsonl")).pipe(
        Effect.orElseSucceed(() => []),
      );
      const usage = parseKimiContextUsage({ contextLines, wireLines });
      if (usage === undefined) return undefined;
      if (usage.maxTokens !== undefined) windowSizes.set(request.sessionId, usage.maxTokens);
      const maxTokens = usage.maxTokens ?? windowSizes.get(request.sessionId);
      return maxTokens === undefined ? usage : { usedTokens: usage.usedTokens, maxTokens };
    }).pipe(Effect.orElseSucceed(() => undefined));
};
