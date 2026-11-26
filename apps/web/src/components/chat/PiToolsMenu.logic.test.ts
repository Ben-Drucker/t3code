import type { PiTool } from "@t3tools/contracts";
import { piToolPath } from "@t3tools/shared/piToolExposure";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPiToolTree,
  isPiToolDeferred,
  piToolsDeferredState,
  withPiToolsDeferred,
} from "./PiToolsMenu.logic";

const tool = (name: string, loaded = false, deferrable = true): PiTool => ({
  name,
  description: null,
  loaded,
  deferrable,
});

describe("piToolPath", () => {
  it("nests T3 tools by their name parts", () => {
    expect(piToolPath("mcp__t3-code__t3_thread_read")).toEqual(["T3", "thread", "read"]);
    expect(piToolPath("mcp__t3-code__t3_x_y_z_w")).toEqual(["T3", "x_y_z", "w"]);
    expect(piToolPath("mcp__t3-code__t3_queue")).toEqual(["T3", "t3_queue"]);
    expect(piToolPath("mcp__t3-code__delegate_task")).toEqual(["T3", "delegate_task"]);
  });

  it("puts other servers' tools under the server and Pi's own under Pi", () => {
    expect(piToolPath("mcp__crawl4ai__crawl_url")).toEqual(["crawl4ai", "crawl_url"]);
    expect(piToolPath("read")).toEqual(["Pi", "read"]);
  });
});

describe("Pi tool tree", () => {
  const tools = [
    tool("read", true, false),
    tool("mcp__t3-code__t3_thread_read"),
    tool("mcp__t3-code__t3_thread_list", true),
    tool("mcp__t3-code__delegate_task", true),
  ];

  it("lists T3 first, folders before tools", () => {
    const tree = buildPiToolTree(tools);
    expect(tree.map((node) => node.label)).toEqual(["T3", "Pi"]);
    expect(tree[0]!.children.map((node) => node.label)).toEqual(["thread", "delegate_task"]);
    expect(tree[0]!.children[0]!.children.map((node) => node.label)).toEqual(["list", "read"]);
  });

  it("defers a folder's deferrable tools and leaves Pi's own alone", () => {
    const next = withPiToolsDeferred({}, tools, true);
    expect(next).toEqual({
      "mcp__t3-code__t3_thread_read": "deferred",
      "mcp__t3-code__t3_thread_list": "deferred",
      "mcp__t3-code__delegate_task": "deferred",
    });
    expect(piToolsDeferredState(tools, next)).toBe("all");
    expect(piToolsDeferredState(tools, {})).toBe("some");
  });

  it("falls back to what the session loaded when the thread has no choice", () => {
    expect(isPiToolDeferred(tools[1]!, {})).toBe(true);
    expect(isPiToolDeferred(tools[2]!, {})).toBe(false);
    expect(isPiToolDeferred(tools[2]!, { "mcp__t3-code__t3_thread_list": "deferred" })).toBe(true);
  });
});
