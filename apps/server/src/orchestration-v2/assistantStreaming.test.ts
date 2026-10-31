import { describe, expect, it } from "vite-plus/test";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  isStreamingTextEvent,
  LIVE_STREAMING_MIN_INTERVAL_MS,
  makeAssistantStreamingFilter,
  splitBufferedAssistantText,
} from "./assistantStreaming.ts";

const reasoningUpdate = (text: string, streaming = true) =>
  ({
    type: "turn_item.updated",
    turnItem: { type: "reasoning", id: "item-1", text, streaming },
  }) as unknown as ProviderAdapter.ProviderAdapterV2Event;

const textOf = (event: ProviderAdapter.ProviderAdapterV2Event | null) =>
  event?.type === "turn_item.updated" && event.turnItem.type === "reasoning"
    ? event.turnItem.text
    : null;

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

describe("V2 live streaming filter", () => {
  it("delivers partial text mid-paragraph in live mode, unlike paragraph mode", () => {
    const partial = reasoningUpdate("Thinking about the first");
    expect(makeAssistantStreamingFilter("paragraph")(partial, 0, false)).toBeNull();
    expect(textOf(makeAssistantStreamingFilter("paragraph")(partial, 0, true))).toBe(
      "Thinking about the first",
    );
  });

  it("delivers live text even in turn mode", () => {
    const filter = makeAssistantStreamingFilter("turn");
    expect(filter(reasoningUpdate("abc"), 0, false)).toBeNull();
    expect(textOf(filter(reasoningUpdate("abc"), 1, true))).toBe("abc");
  });

  it("throttles live updates per item and always passes the final update", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(textOf(filter(reasoningUpdate("a"), 1_000, true))).toBe("a");
    expect(
      filter(reasoningUpdate("ab"), 1_000 + LIVE_STREAMING_MIN_INTERVAL_MS - 1, true),
    ).toBeNull();
    expect(
      textOf(filter(reasoningUpdate("abc"), 1_000 + LIVE_STREAMING_MIN_INTERVAL_MS, true)),
    ).toBe("abc");
    expect(textOf(filter(reasoningUpdate("abcd", false), 1_001, true))).toBe("abcd");
    // The completed item resets throttling state.
    expect(textOf(filter(reasoningUpdate("x"), 1_002, true))).toBe("x");
  });

  it("skips empty and unchanged live text", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(reasoningUpdate(""), 0, true)).toBeNull();
    expect(textOf(filter(reasoningUpdate("a"), 0, true))).toBe("a");
    expect(filter(reasoningUpdate("a"), 10_000, true)).toBeNull();
  });

  it("recognizes streaming text events", () => {
    expect(isStreamingTextEvent(reasoningUpdate("a"))).toBe(true);
    expect(isStreamingTextEvent(reasoningUpdate("a", false))).toBe(false);
  });
});
