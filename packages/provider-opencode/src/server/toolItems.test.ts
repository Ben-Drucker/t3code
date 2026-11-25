import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TOOL_OUTPUT_IMAGES,
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";

import { openCodeToolOutput, openCodeToolTurnItem } from "./toolItems.ts";

describe("openCodeToolOutput", () => {
  it("preserves inline raster file content and leaves other files unserved", () => {
    const output = openCodeToolOutput("Preview complete", [
      { uri: "https://example.com/preview.png", mime: "image/png" },
      { uri: "file:///tmp/preview.png", mime: "image/png" },
      { uri: "data:image/svg+xml;base64,AAAA", mime: "image/svg+xml" },
      { uri: "data:image/png;base64,AAAA", mime: "image/jpeg" },
      { uri: "data:image/png;base64,", mime: "image/png" },
      { uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
    ]);
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(output).toEqual({
      content: [
        { type: "text", text: "Preview complete" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    expect(openCodeToolOutput("Text result")).toBe("Text result");
    const oversized = "A".repeat(MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4);
    const bounded = openCodeToolOutput(
      "Preview complete",
      Array.from({ length: MAX_TOOL_OUTPUT_IMAGES + 2 }, (_, index) => ({
        uri: `data:image/png;base64,${index === 0 ? oversized : "AQ=="}`,
        mime: "image/png",
      })),
    );
    expect(typeof bounded === "object" ? bounded.content.length : 0).toBe(
      MAX_TOOL_OUTPUT_IMAGES + 1,
    );
    const images = toolOutputImages(bounded);
    expect(images[0]?.data?.length).toBe(oversized.length);
    expect(images[1]?.data).toBe("AQ==");
  });
});

describe("openCodeToolTurnItem", () => {
  it.each([
    ["read", "filePath", "images/photo.JPEG", "images/photo.JPEG"],
    ["read_file", "file_path", "images/photo.jpg", "images/photo.jpg"],
    ["Read", "path", "images/photo.jpe", "images/photo.jpe"],
    ["read", "file", "images/photo.jfif", "images/photo.jfif"],
    ["read", "filePath", "images/capture.PNG", "images/capture.PNG"],
    ["read", "filePath", "images/motion.gif", "images/motion.gif"],
    ["read", "filePath", "images/scan.tif", "images/scan.tif"],
    ["read", "filePath", "images/scan.TIFF", "images/scan.TIFF"],
    ["read", "filePath", "images/photo.png.txt", undefined],
    ["read", "filePath", "images/photo.png\nother.png", undefined],
    ["read", "filePath", "images/photo\0.png", undefined],
    ["read", "filePath", `${"a".repeat(4097)}.png`, undefined],
    ["mcp__other__read_file", "path", "images/photo.png", undefined],
  ])("marks an image read from %s %s (%#)", (name, key, path, expected) => {
    const item = openCodeToolTurnItem(
      {
        id: TurnItemId.make("image-read"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: name,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(0),
      },
      { name, input: { [key]: path }, output: "read", completedMetadata: undefined },
    );
    expect(item.type === "dynamic_tool" ? item.viewedImagePath : undefined).toBe(expected);
  });

  it.each([
    {
      name: "deletion",
      toolName: "edit",
      input: { oldString: "old\n", newString: "", newText: "fallback" },
      expected: { oldStr: "old\n", newStr: "" },
    },
    {
      name: "whitespace replacement",
      toolName: "edit",
      input: { oldString: " \t", newString: "\n\t" },
      expected: { oldStr: " \t", newStr: "\n\t" },
    },
    {
      name: "empty write",
      toolName: "write",
      input: { content: "" },
      expected: { newStr: "" },
    },
  ])("preserves exact file content for $name", ({ toolName, input, expected }) => {
    const item = openCodeToolTurnItem(
      {
        id: TurnItemId.make("tool-item"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: toolName,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
      },
      {
        name: toolName,
        input: { filePath: "src/index.ts", ...input },
        output: undefined,
        completedMetadata: undefined,
      },
    );
    expect(item).toMatchObject({ type: "file_change", fileName: "src/index.ts", ...expected });
  });

  it("extracts patchText and filediff stats for apply_patch and write tools", () => {
    const base = {
      id: TurnItemId.make("tool-item"),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: "apply_patch",
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
    };
    const patched = openCodeToolTurnItem(base, {
      name: "apply_patch",
      input: {
        filePath: "src/index.ts",
        patchText: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
      output: "Patched",
      completedMetadata: undefined,
    });
    expect(patched).toMatchObject({
      type: "file_change",
      diffStr: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
    });

    const withFileDiff = openCodeToolTurnItem(
      { ...base, title: "edit" },
      {
        name: "edit",
        input: { filePath: "src/other.ts" },
        output: "Edited",
        completedMetadata: { filediff: { additions: 3, deletions: 1 } },
      },
    );
    expect(withFileDiff).toMatchObject({
      type: "file_change",
      additions: 3,
      deletions: 1,
    });
  });

  it("splits grep output into one result per matched line", () => {
    const item = openCodeToolTurnItem(
      {
        id: TurnItemId.make("grep-item"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: "grep",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
      },
      {
        name: "grep",
        input: { pattern: "export const \\w+", path: "/repo/src" },
        // Captured from OpenCode 2.4.1.
        output:
          'Found 2 matches\n/repo/src/one.ts:\n  Line 1: export const heading = "intro";\n\n\n/repo/src/two.ts:\n  Line 1: export const second = 2;',
        completedMetadata: undefined,
      },
    );
    expect(item).toMatchObject({
      type: "file_search",
      pattern: "export const \\w+",
      results: [
        { fileName: "/repo/src/one.ts", line: 1, preview: 'export const heading = "intro";' },
        { fileName: "/repo/src/two.ts", line: 1, preview: "export const second = 2;" },
      ],
    });
  });
});
