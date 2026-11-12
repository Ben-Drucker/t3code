import type { ComposerToolGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentToolSectionId,
  buildAgentToolSections,
  matchesAgentModelRow,
} from "./agentToolMenu.ts";

const groups: ReadonlyArray<ComposerToolGroup> = [
  {
    source: "T3",
    kind: "t3",
    status: "ready",
    tools: [
      { name: "task_status", description: "Report a task's state" },
      { name: "preview_open", description: null },
    ],
  },
  {
    source: "Claude",
    kind: "provider",
    status: "ready",
    tools: [
      { name: "Read", description: "Read a file", deferred: true },
      { name: "CronCreate", description: null, deferred: true },
    ],
  },
  {
    source: "Codex",
    kind: "provider",
    status: "ready",
    tools: [{ name: "shell.run", description: null }],
  },
  { source: "zeta", kind: "mcp", status: "needs-auth", tools: [] },
  { source: "alpha", kind: "mcp", status: "down", tools: [] },
  {
    source: "playwright",
    kind: "mcp",
    status: "ready",
    tools: [{ name: "browser_click", description: "Click an element" }],
  },
  {
    source: "tasks",
    kind: "mcp",
    status: "ready",
    tools: [{ name: "task_list", description: null }],
  },
];

const sourcesOf = (sections: ReturnType<typeof buildAgentToolSections>) =>
  sections.map((section) => section.group.source);

describe("buildAgentToolSections", () => {
  it("orders T3, provider sources, then MCP servers by name, and opens only T3 by default", () => {
    const sections = buildAgentToolSections(groups, "", new Map());

    expect(sourcesOf(sections)).toEqual([
      "T3",
      "Claude",
      "Codex",
      "alpha",
      "playwright",
      "tasks",
      "zeta",
    ]);
    expect(sections.map((section) => section.expanded)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("applies section open and closed overrides when unfiltered", () => {
    const overrides = new Map([
      [agentToolSectionId("T3"), false],
      [agentToolSectionId("Claude"), true],
    ]);

    const sections = buildAgentToolSections(groups, "", overrides);

    expect(sections.slice(0, 2).map((section) => section.expanded)).toEqual([false, true]);
  });

  it("hides sections without a match and opens the ones that match", () => {
    const sections = buildAgentToolSections(groups, "click", new Map());

    expect(sourcesOf(sections)).toEqual(["playwright"]);
    expect(sections[0]).toMatchObject({
      expanded: true,
      tools: [{ name: "browser_click" }],
    });
  });

  it("matches a description as well as the source and tool label", () => {
    const sections = buildAgentToolSections(groups, "element", new Map());

    expect(sourcesOf(sections)).toEqual(["playwright"]);
  });

  it("matches source > tool names before descriptions", () => {
    const sections = buildAgentToolSections(
      [
        {
          source: "T3",
          kind: "t3",
          status: "ready",
          tools: [
            { name: "other", description: "open a preview tab" },
            { name: "preview_open", description: null },
          ],
        },
      ],
      "preview",
      new Map(),
    );

    expect(sections[0]?.tools.map((tool) => tool.name)).toEqual(["preview_open", "other"]);
  });

  it("keeps empty status sections that match by source name while opening all matches", () => {
    const sections = buildAgentToolSections(groups, "alpha", new Map());

    expect(sections).toEqual([
      expect.objectContaining({
        expanded: true,
        group: expect.objectContaining({ source: "alpha" }),
      }),
    ]);
  });

  it("orders matching sections by their best match", () => {
    const sections = buildAgentToolSections(groups, "task", new Map());

    expect(sourcesOf(sections)).toEqual(["tasks", "T3"]);
  });

  it("matches multi-word queries across source, tool name words, and description", () => {
    expect(
      buildAgentToolSections(groups, "t3 status", new Map()).map((section) => [
        section.group.source,
        section.tools.map((tool) => tool.name),
      ]),
    ).toEqual([["T3", ["task_status"]]]);

    expect(
      buildAgentToolSections(groups, "preview open", new Map()).map((section) => [
        section.group.source,
        section.tools.map((tool) => tool.name),
      ]),
    ).toEqual([["T3", ["preview_open"]]]);

    expect(
      buildAgentToolSections(groups, "cron create", new Map()).map((section) => [
        section.group.source,
        section.tools.map((tool) => tool.name),
      ]),
    ).toEqual([["Claude", ["CronCreate"]]]);

    expect(
      buildAgentToolSections(groups, "playwright element", new Map()).map((section) => [
        section.group.source,
        section.tools.map((tool) => tool.name),
      ]),
    ).toEqual([["playwright", ["browser_click"]]]);

    expect(
      buildAgentToolSections(groups, "alpha beta", new Map()).map((section) => [
        section.group.source,
        section.tools.map((tool) => tool.name),
      ]),
    ).toEqual([]);
  });

  it("matches the Model row for empty or model-related queries", () => {
    expect(matchesAgentModelRow("")).toBe(true);
    expect(matchesAgentModelRow("   ")).toBe(true);
    expect(matchesAgentModelRow("model")).toBe(true);
    expect(matchesAgentModelRow("choose options")).toBe(true);
    expect(matchesAgentModelRow("playwright")).toBe(false);
  });
});
