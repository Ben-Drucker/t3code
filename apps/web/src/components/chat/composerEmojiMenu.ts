import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

export type EmojiShortcodeEntry = {
  readonly name: string;
  readonly emoji: string;
};

const SLACK_GITHUB_SHORTCODE_ALIASES: ReadonlyArray<EmojiShortcodeEntry> = [
  { name: "thumbsup", emoji: "👍" },
  { name: "thumbsdown", emoji: "👎" },
  { name: "simple_smile", emoji: "🙂" },
  { name: "slightly_smiling_face", emoji: "🙂" },
  { name: "thinking", emoji: "🤔" },
  { name: "partying_face", emoji: "🥳" },
  { name: "saluting_face", emoji: "🫡" },
  { name: "melting_face", emoji: "🫠" },
];

const DEFAULT_EMOJI_RESULT_LIMIT = 32;

let cachedEmojiEntries: ReadonlyArray<EmojiShortcodeEntry> | null = null;
let emojiEntriesPromise: Promise<ReadonlyArray<EmojiShortcodeEntry>> | null = null;

function buildEmojiShortcodeEntries(
  rawEntries: ReadonlyArray<EmojiShortcodeEntry>,
): EmojiShortcodeEntry[] {
  const seen = new Set<string>();
  const merged: EmojiShortcodeEntry[] = [];
  for (const entry of [...rawEntries, ...SLACK_GITHUB_SHORTCODE_ALIASES]) {
    const normalizedName = entry.name.trim().toLowerCase();
    if (!normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    merged.push({ name: normalizedName, emoji: entry.emoji });
  }
  return merged;
}

export function getCachedEmojiShortcodeEntries(): ReadonlyArray<EmojiShortcodeEntry> | null {
  return cachedEmojiEntries;
}

export function loadEmojiShortcodeEntries(): Promise<ReadonlyArray<EmojiShortcodeEntry>> {
  if (cachedEmojiEntries !== null) {
    return Promise.resolve(cachedEmojiEntries);
  }
  emojiEntriesPromise ??= import("node-emoji").then((mod) => {
    const built = buildEmojiShortcodeEntries(
      mod.search("").map((entry) => ({ name: entry.name, emoji: entry.emoji })),
    );
    cachedEmojiEntries = built;
    return built;
  });
  return emojiEntriesPromise;
}

function scoreEmojiShortcode(name: string, query: string): number | null {
  return scoreQueryMatch({
    value: name,
    query,
    exactBase: 0,
    prefixBase: 100,
    includesBase: 400,
    fuzzyBase: 1000,
  });
}

export function rankEmojiShortcodes(
  entries: ReadonlyArray<EmojiShortcodeEntry>,
  rawQuery: string,
  limit = DEFAULT_EMOJI_RESULT_LIMIT,
): EmojiShortcodeEntry[] {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return [];
  const scored: Array<{ readonly entry: EmojiShortcodeEntry; readonly score: number }> = [];
  for (const entry of entries) {
    const score = scoreEmojiShortcode(entry.name, query);
    if (score !== null) {
      scored.push({ entry, score });
    }
  }
  scored.sort(
    (left, right) => left.score - right.score || left.entry.name.localeCompare(right.entry.name),
  );
  return scored.slice(0, limit).map((item) => item.entry);
}
