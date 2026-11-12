import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger } from "../../composer-logic";
import {
  loadEmojiShortcodeEntries,
  rankEmojiShortcodes,
  type EmojiShortcodeEntry,
} from "./composerEmojiMenu";

describe("emoji colon trigger detection", () => {
  it("opens at start of text or right after whitespace when followed by a lowercase letter", () => {
    expect(detectComposerTrigger(":thu", 4)).toEqual({
      kind: "emoji",
      query: "thu",
      rangeStart: 0,
      rangeEnd: 4,
    });
    expect(detectComposerTrigger(" :smi", 5)).toEqual({
      kind: "emoji",
      query: "smi",
      rangeStart: 1,
      rangeEnd: 5,
    });
    expect(detectComposerTrigger("hello\n:white_check_mark", 23)).toEqual({
      kind: "emoji",
      query: "white_check_mark",
      rangeStart: 6,
      rangeEnd: 23,
    });
  });

  it("does not open for times, URLs, mid-word colons, bare colons, or whitespace after colon", () => {
    expect(detectComposerTrigger("10:30", 5)).toBeNull();
    expect(detectComposerTrigger("https://x", 9)).toBeNull();
    expect(detectComposerTrigger("a::b", 4)).toBeNull();
    expect(detectComposerTrigger(":", 1)).toBeNull();
    expect(detectComposerTrigger(": x", 3)).toBeNull();
    expect(detectComposerTrigger(":thu ", 5)).toBeNull();
    expect(detectComposerTrigger(":thu:", 5)).toBeNull();
  });
});

describe("rankEmojiShortcodes", () => {
  const sampleEntries: ReadonlyArray<EmojiShortcodeEntry> = [
    { name: "small_airplane", emoji: "🛩️" },
    { name: "cat_smile", emoji: "😺" },
    { name: "smile", emoji: "😄" },
  ];

  it("ranks prefix matches above substring matches above subsequence matches", () => {
    const ranked = rankEmojiShortcodes(sampleEntries, "smi");
    expect(ranked.map((entry) => entry.name)).toEqual(["smile", "cat_smile", "small_airplane"]);
  });

  it("includes Slack and GitHub shortcodes from the lazy dataset", async () => {
    const entries = await loadEmojiShortcodeEntries();
    expect(rankEmojiShortcodes(entries, "thumbsup")[0]).toEqual({
      name: "thumbsup",
      emoji: "👍",
    });
    expect(entries.some((entry) => entry.name === "+1" && entry.emoji === "👍")).toBe(true);
    expect(rankEmojiShortcodes(entries, "tada")[0]).toEqual({
      name: "tada",
      emoji: "🎉",
    });
    expect(rankEmojiShortcodes(entries, "white_check_mark")[0]).toEqual({
      name: "white_check_mark",
      emoji: "✅",
    });
  });
});
