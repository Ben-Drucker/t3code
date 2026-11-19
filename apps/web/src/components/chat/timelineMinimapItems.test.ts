import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import {
  resolveTimelineMinimapAutoScrollTop,
  resolveTimelineMinimapEdgeFade,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapItemOffset,
  resolveTimelineMinimapMaskImage,
  resolveTimelineMinimapTrackHeight,
  TIMELINE_MINIMAP_ITEM_SPACING,
} from "./MessagesTimeline.logic";

describe("deriveTimelineMinimapItems", () => {
  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("image-only"),
            role: "user",
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
      expect(items).toEqual([{ id: "image-only", rowIndex: 0, userText: "", assistantText: null }]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });

  it("previews a quote, a context chip and a file link in the user's message as their text", () => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("assistant-1"),
      text: "The cache misses on a cold start.",
      start: 0,
      end: 33,
      prefix: "",
      suffix: "",
    });
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: `${quote}\nWhere do ${file} and [math.ts](src/math.ts) cover this?`,
      assistantText: null,
    });
    expect(preview?.userText).toBe(
      "The cache misses on a cold start. Where do README.md and math.ts cover this?",
    );
  });
});

describe("timeline minimap rail layout and scrolling", () => {
  it("keeps fixed even tick spacing regardless of conversation length", () => {
    expect(resolveTimelineMinimapItemOffset(1) - resolveTimelineMinimapItemOffset(0)).toBe(
      TIMELINE_MINIMAP_ITEM_SPACING,
    );
    expect(resolveTimelineMinimapItemOffset(250) - resolveTimelineMinimapItemOffset(249)).toBe(
      TIMELINE_MINIMAP_ITEM_SPACING,
    );
  });

  it("fades only edges that have more ticks beyond them", () => {
    expect(
      resolveTimelineMinimapEdgeFade({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 }),
    ).toEqual({ fadeTop: false, fadeBottom: false });
    expect(resolveTimelineMinimapMaskImage({ fadeTop: false, fadeBottom: false })).toBeUndefined();

    const atTop = resolveTimelineMinimapEdgeFade({
      scrollTop: 0,
      clientHeight: 200,
      scrollHeight: 600,
    });
    expect(atTop).toEqual({ fadeTop: false, fadeBottom: true });
    expect(resolveTimelineMinimapMaskImage(atTop)).toContain("black 0px");

    const inMiddle = resolveTimelineMinimapEdgeFade({
      scrollTop: 150,
      clientHeight: 200,
      scrollHeight: 600,
    });
    expect(inMiddle).toEqual({ fadeTop: true, fadeBottom: true });

    const atBottom = resolveTimelineMinimapEdgeFade({
      scrollTop: 400,
      clientHeight: 200,
      scrollHeight: 600,
    });
    expect(atBottom).toEqual({ fadeTop: true, fadeBottom: false });
    expect(resolveTimelineMinimapMaskImage(atBottom)).toContain("black 100%");
  });

  it("auto-scrolls the rail to keep the active tick in view", () => {
    const itemCount = 100;
    const scrollHeight = resolveTimelineMinimapTrackHeight(itemCount);
    const clientHeight = 200;

    expect(
      resolveTimelineMinimapAutoScrollTop({
        targetIndex: 5,
        itemCount,
        scrollTop: 0,
        clientHeight,
        scrollHeight,
      }),
    ).toBeNull();

    const scrolledDown = resolveTimelineMinimapAutoScrollTop({
      targetIndex: 60,
      itemCount,
      scrollTop: 0,
      clientHeight,
      scrollHeight,
    });
    expect(scrolledDown).not.toBeNull();
    expect(resolveTimelineMinimapItemOffset(60)).toBeGreaterThanOrEqual(scrolledDown!);
    expect(resolveTimelineMinimapItemOffset(60)).toBeLessThanOrEqual(scrolledDown! + clientHeight);

    expect(
      resolveTimelineMinimapAutoScrollTop({
        targetIndex: 99,
        itemCount,
        scrollTop: 0,
        clientHeight,
        scrollHeight,
      }),
    ).toBe(scrollHeight - clientHeight);

    expect(
      resolveTimelineMinimapAutoScrollTop({
        targetIndex: 0,
        itemCount,
        scrollTop: 300,
        clientHeight,
        scrollHeight,
      }),
    ).toBe(0);
  });

  it("resolves hovered/clicked tick index accounting for rail scrollTop", () => {
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 100,
        railTop: 100,
        railHeight: 200,
        scrollTop: 160,
        pointerY: 104,
      }),
    ).toBe(20);
  });
});
