/**
 * Fork: live context usage for Kimi Code. Its ACP server sends no per-step usage, but the CLI
 * appends it to the session's `agents/main/wire.jsonl` as it goes. Layout verified against Kimi Code
 * 2.3.3: `<share>/sessions/<bucket>/<session>/agents/main/wire.jsonl`, where each model step ends
 * with a `token_counting.measured` record whose `tokens` is the current context size.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// A tool-heavy step can leave a lot of text between usage records, so read a wide tail.
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
  input.environment.KIMI_CODE_HOME?.trim() || input.path.join(input.homeDirectory, ".kimi-code");

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

export interface KimiContextUsage {
  readonly usedTokens: number;
  readonly maxTokens?: number;
}

/** Newest context size and the model alias in force, from the tail of a wire file. */
export function parseKimiWireTail(lines: ReadonlyArray<string>): {
  readonly usedTokens?: number;
  readonly modelAlias?: string;
} {
  let usedTokens: number | undefined;
  let modelAlias: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = asRecord(parseLine(lines[index]!));
    if (record === undefined) continue;
    if (
      usedTokens === undefined &&
      (record.type === "token_counting.measured" || record.type === "token_counting.turn_recorded")
    ) {
      usedTokens = positiveNumber(record.tokens);
    }
    if (
      modelAlias === undefined &&
      (record.type === "llm.request" || record.type === "profile.bind") &&
      typeof record.modelAlias === "string"
    ) {
      modelAlias = record.modelAlias;
    }
    if (usedTokens !== undefined && modelAlias !== undefined) break;
  }
  return {
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(modelAlias === undefined ? {} : { modelAlias }),
  };
}

/**
 * `max_context_size` per `[models."<alias>"]` section of the CLI's config.toml. The CLI rewrites that
 * value whenever it refreshes its model list, so `[models."<alias>".overrides]` wins when present.
 */
export function parseKimiModelWindows(configText: string): ReadonlyMap<string, number> {
  const base = new Map<string, number>();
  const overrides = new Map<string, number>();
  let target: { readonly alias: string; readonly sizes: Map<string, number> } | undefined;
  for (const line of configText.split("\n")) {
    const header = /^\s*\[models\.(?:"([^"]+)"|([^\].\s]+))(\.overrides)?\]\s*$/.exec(line);
    if (header !== null) {
      target = {
        alias: header[1] ?? header[2]!,
        sizes: header[3] === undefined ? base : overrides,
      };
      continue;
    }
    if (/^\s*\[/.test(line)) {
      target = undefined;
      continue;
    }
    const size = target === undefined ? null : /^\s*max_context_size\s*=\s*(\d+)/.exec(line);
    if (target !== undefined && size !== null) target.sizes.set(target.alias, Number(size[1]));
  }
  return new Map([...base, ...overrides]);
}

/** Reads the newest context size of a Kimi Code session from its files. Never fails. */
export const makeKimiContextUsageReader = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}) => {
  const { fs, path } = input;
  const shareDirectory = resolveKimiShareDirectory(input);
  const sessionsRoot = path.join(shareDirectory, "sessions");
  const wireFiles = new Map<string, string>();
  let modelWindows: ReadonlyMap<string, number> | undefined;

  const wireFileIn = (sessionDirectory: string) =>
    path.join(sessionDirectory, "agents", "main", "wire.jsonl");

  const mtimeMillis = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => Option.getOrElse(Option.map(info.mtime, Number), () => 0)),
      Effect.orElseSucceed(() => 0),
    );

  // The ACP session id names the session folder, with or without Kimi's `session_` prefix.
  const locate = Effect.fnUntraced(function* (sessionId: string) {
    const cached = wireFiles.get(sessionId);
    if (cached !== undefined) return cached;
    const names = [sessionId, `session_${sessionId.replace(/^session_/, "")}`];
    const buckets = yield* fs.readDirectory(sessionsRoot);
    let newest: { readonly file: string; readonly mtime: number } | undefined;
    for (const bucket of buckets) {
      for (const name of names) {
        const file = wireFileIn(path.join(sessionsRoot, bucket, name));
        // `exists` fails (ENOTDIR) when a bucket entry is a stray file such as `.DS_Store`.
        if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
          wireFiles.set(sessionId, file);
          return file;
        }
      }
      // Fallback for an id that names no folder: the most recently written session.
      const sessions = yield* fs
        .readDirectory(path.join(sessionsRoot, bucket))
        .pipe(Effect.orElseSucceed(() => []));
      for (const session of sessions) {
        const file = wireFileIn(path.join(sessionsRoot, bucket, session));
        const mtime = yield* mtimeMillis(file);
        if (mtime > (newest?.mtime ?? 0)) newest = { file, mtime };
      }
    }
    if (newest !== undefined) wireFiles.set(sessionId, newest.file);
    return newest?.file;
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

  const windowFor = Effect.fnUntraced(function* (modelAlias: string | undefined) {
    if (modelAlias === undefined) return undefined;
    if (modelWindows === undefined || !modelWindows.has(modelAlias)) {
      const text = yield* fs
        .readFileString(path.join(shareDirectory, "config.toml"))
        .pipe(Effect.orElseSucceed(() => ""));
      modelWindows = parseKimiModelWindows(text);
    }
    return modelWindows.get(modelAlias);
  });

  return (request: { readonly sessionId: string }): Effect.Effect<KimiContextUsage | undefined> =>
    Effect.gen(function* () {
      const file = yield* locate(request.sessionId);
      if (file === undefined) return undefined;
      const tail = parseKimiWireTail(yield* readTail(file));
      if (tail.usedTokens === undefined) return undefined;
      const maxTokens = yield* windowFor(tail.modelAlias);
      return maxTokens === undefined
        ? { usedTokens: tail.usedTokens }
        : { usedTokens: tail.usedTokens, maxTokens };
    }).pipe(Effect.orElseSucceed(() => undefined));
};
