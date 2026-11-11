import type { ComposerToolGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentToolSectionId, buildAgentToolSections } from "./agentToolMenu.ts";

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

  it("applies the user's open and closed choices by section id", () => {
    const sections = buildAgentToolSections(
      groups,
      "",
      new Map([
        [agentToolSectionId("Claude"), true],
        [agentToolSectionId("T3"), false],
      ]),
    );

    expect(sections.find((section) => section.group.source === "Claude")?.expanded).toBe(true);
    expect(sections.find((section) => section.group.source === "T3")?.expanded).toBe(false);
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

  it("keeps a server with no tools when its own name matches", () => {
    const sections = buildAgentToolSections(groups, "alpha", new Map());

    expect(sections).toEqual([
      expect.objectContaining({
        tools: [],
        expanded: true,
        group: expect.objectContaining({ source: "alpha" }),
      }),
    ]);
  });

  it("orders matching sections by their best match", () => {
    const sections = buildAgentToolSections(groups, "task", new Map());

    expect(sourcesOf(sections)).toEqual(["tasks", "T3"]);
  });
});
