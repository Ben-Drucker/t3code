import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentConfigPlainText,
  chipBadges,
  modelChipView,
  splitAgentConfigText,
  toolSourceKind,
  type ChipCatalogEntry,
} from "./agentConfigChipModel.ts";

const effort = {
  type: "select",
  id: "effort",
  label: "Effort",
  role: "reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
} satisfies ProviderOptionDescriptor;

const fastMode = {
  type: "boolean",
  id: "fastMode",
  label: "Fast mode",
  currentValue: false,
} satisfies ProviderOptionDescriptor;

const contextLimit = {
  type: "select",
  id: "contextLimit",
  label: "Context limit",
  options: [
    { id: "default", label: "Default", isDefault: true },
    { id: "500000", label: "500K" },
  ],
} satisfies ProviderOptionDescriptor;

const compactBuffer = {
  type: "select",
  id: "compactBuffer",
  label: "Buffer",
  options: [
    { id: "default", label: "Default", isDefault: true },
    { id: "10", label: "10%" },
  ],
} satisfies ProviderOptionDescriptor;

const haiku = {
  slug: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  isCustom: false,
  capabilities: { optionDescriptors: [effort, fastMode, contextLimit, compactBuffer] },
} satisfies ServerProviderModel;

const claude: ChipCatalogEntry = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  models: [haiku],
};

describe("splitAgentConfigText", () => {
  it("splits model and tool chips from plain text in order", () => {
    const text =
      "Use %[tool: T3 > task_status] with %[model: claudeAgent/claude-haiku-5-5, effort=high] now";

    expect(splitAgentConfigText(text)).toEqual([
      { type: "text", text: "Use " },
      {
        type: "tool",
        raw: "%[tool: T3 > task_status]",
        chip: { source: "T3", tool: "task_status" },
      },
      { type: "text", text: " with " },
      {
        type: "model",
        raw: "%[model: claudeAgent/claude-haiku-5-5, effort=high]",
        chip: {
          instanceId: "claudeAgent",
          model: "claude-haiku-5-5",
          options: [{ id: "effort", value: "high" }],
        },
      },
      { type: "text", text: " now" },
    ]);
  });

  it("leaves a malformed or unfinished chip as plain text", () => {
    expect(splitAgentConfigText("see %[model: claudeAgent/x")).toEqual([
      { type: "text", text: "see %[model: claudeAgent/x" },
    ]);
  });
});

describe("chipBadges", () => {
  it("shows the reasoning label, Fast, the context limit, and the buffer when they differ from defaults", () => {
    expect(
      chipBadges(haiku, [
        { id: "effort", value: "high" },
        { id: "fastMode", value: "true" },
        { id: "contextLimit", value: "500000" },
        { id: "compactBuffer", value: "10" },
      ]),
    ).toEqual(["High", "Fast", "500K", "10% free"]);
  });

  it("skips options that are on their defaults", () => {
    expect(
      chipBadges(haiku, [
        { id: "effort", value: "medium" },
        { id: "fastMode", value: "false" },
        { id: "contextLimit", value: "default" },
        { id: "compactBuffer", value: "default" },
      ]),
    ).toEqual([]);
  });
});

describe("modelChipView", () => {
  it("resolves the model name and badges from the catalog", () => {
    const [segment] = splitAgentConfigText("%[model: claudeAgent/claude-haiku-5-5, effort=high]");
    if (segment?.type !== "model") throw new Error("expected a model chip");

    expect(modelChipView(segment.chip, [claude])).toEqual({
      kind: "model",
      entry: claude,
      modelLabel: "Haiku 5.5",
      badges: ["High"],
    });
  });

  it("falls back to the raw instance and model when the catalog lacks them", () => {
    const [segment] = splitAgentConfigText("%[model: codex/gpt-5, effort=high]");
    if (segment?.type !== "model") throw new Error("expected a model chip");

    expect(modelChipView(segment.chip, [claude])).toEqual({
      kind: "raw",
      text: "codex/gpt-5",
    });
  });
});

describe("toolSourceKind", () => {
  it("names T3, the provider sources, and everything else as an MCP server", () => {
    expect(toolSourceKind("T3")).toEqual({ kind: "t3" });
    expect(toolSourceKind("Claude")).toEqual({
      kind: "provider",
      driverKind: ProviderDriverKind.make("claudeAgent"),
    });
    expect(toolSourceKind("playwright")).toEqual({ kind: "mcp" });
  });
});

describe("agentConfigPlainText", () => {
  it("writes chips in their readable form for plain-text surfaces", () => {
    expect(
      agentConfigPlainText(
        "Ran %[tool: T3 > task_status] on %[model: claudeAgent/claude-haiku-5-5, effort=high]",
        [claude],
      ),
    ).toBe("Ran T3 › task_status on Haiku 5.5 · High");
  });
});
