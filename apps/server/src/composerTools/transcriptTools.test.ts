import { describe, expect, it } from "vite-plus/test";

import {
  claudeDeferredToolNames,
  codexAdditionalTools,
  splitClaudeMcpToolName,
} from "./transcriptTools.ts";

const deferred = (added: string[], removed: string[] = []) =>
  JSON.stringify({
    type: "attachment",
    attachment: { type: "deferred_tools_delta", addedNames: added, removedNames: removed },
  });

describe("Claude deferred tool names", () => {
  it("applies additions and removals in transcript order", () => {
    const lines = [
      deferred(["CronCreate", "CronDelete", "mcp__acp-bridge__ask"]),
      deferred(["Monitor"], ["CronDelete"]),
      deferred(["CronDelete"]),
      JSON.stringify({ type: "user", message: { content: "not a delta" } }),
      "{ truncated",
    ];

    expect(claudeDeferredToolNames(lines)).toEqual([
      "CronCreate",
      "CronDelete",
      "Monitor",
      "mcp__acp-bridge__ask",
    ]);
  });
});

describe("Codex additional tools", () => {
  it("flattens namespaces across records and skips MCP namespaces", () => {
    const record = (namespaces: unknown[]) =>
      JSON.stringify({
        type: "response_item",
        payload: { type: "additional_tools", tools: namespaces },
      });
    const lines = [
      record([
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "exec", description: "Run a command" }],
        },
        { type: "namespace", name: "mcp__cua_repl", tools: [{ name: "run" }] },
      ]),
      record([
        {
          type: "namespace",
          name: "clock",
          tools: [{ name: "now" }],
        },
      ]),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    ];

    expect(codexAdditionalTools(lines)).toEqual([
      { name: "clock.now", description: null },
      { name: "functions.exec", description: "Run a command" },
    ]);
  });
});

describe("Claude MCP tool names", () => {
  it.each([
    ["mcp__playwright__browser_click", { server: "playwright", tool: "browser_click" }],
    ["mcp__acp-bridge__tools__list", { server: "acp-bridge", tool: "tools__list" }],
    ["Read", null],
    ["mcp__playwright__", null],
    ["mcp____tool", null],
  ])("splits %s", (name, expected) => {
    expect(splitClaudeMcpToolName(name)).toEqual(expected);
  });
});
