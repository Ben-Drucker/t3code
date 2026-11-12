import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultUrlTransform, type ExtraProps } from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { AgentConfigCatalogContext } from "./AgentConfigChip";
import type { ChipCatalogEntry } from "./agentConfigChipModel";
import { createMarkdownRenderer } from "./markdownRenderer";
import { renderInlineChipMarkdownChildren } from "./SkillInlineText";

const effort = {
  type: "select",
  id: "effort",
  label: "Effort",
  role: "reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
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

const opus = {
  slug: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  isCustom: false,
  capabilities: { optionDescriptors: [effort, contextLimit, compactBuffer] },
} satisfies ServerProviderModel;

const catalog: ReadonlyArray<ChipCatalogEntry> = [
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    models: [opus],
  },
];

function wrapInlineChips<Tag extends "p" | "li" | "td" | "th" | "h3">(tag: Tag) {
  return function Wrapped({ node: _node, children, ...props }: ComponentProps<Tag> & ExtraProps) {
    return createElement(
      tag,
      props,
      renderInlineChipMarkdownChildren(children, [], undefined, null),
    );
  };
}

const renderMarkdown = createMarkdownRenderer({
  remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
  rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
  urlTransform: defaultUrlTransform,
  components: {
    p: wrapInlineChips("p"),
    li: wrapInlineChips("li"),
    td: wrapInlineChips("td"),
    th: wrapInlineChips("th"),
    h3: wrapInlineChips("h3"),
    code({ node: _node, children, ...props }) {
      return <code {...props}>{children}</code>;
    },
    pre({ node: _node, children, ...props }) {
      return <pre {...props}>{children}</pre>;
    },
  },
});

function renderHtml(markdown: string): string {
  return renderToStaticMarkup(
    <AgentConfigCatalogContext value={catalog}>
      {renderMarkdown(markdown, false)}
    </AgentConfigCatalogContext>,
  );
}

describe("assistant markdown %[...] chip rendering", () => {
  it("renders complete model and tool chips, including multiple chips in one paragraph and punctuation adjacency", () => {
    const html = renderHtml(
      "Use (%[tool: T3 > delegate_task]) with %[model: claudeAgent/claude-opus-4-6, effort=max, contextWindow=200k, contextLimit=500000, compactBuffer=10], then check %[tool: T3 > task_status].",
    );

    expect(html).toContain('data-markdown-copy="%[tool: T3 &gt; delegate_task]"');
    expect(html).toContain(
      'data-markdown-copy="%[model: claudeAgent/claude-opus-4-6, effort=max, contextWindow=200k, contextLimit=500000, compactBuffer=10]"',
    );
    expect(html).toContain('data-markdown-copy="%[tool: T3 &gt; task_status]"');
    expect(html).toContain("Opus 4.6");
    expect(html).toContain("Max");
    expect(html).toContain("500K");
    expect(html).toContain("10% free");
  });

  it("keeps partial streaming syntax as plain text until the closing bracket arrives", () => {
    const partialHtml = renderHtml("Streaming %[tool: T3 > delegate_task");
    expect(partialHtml).not.toContain("data-markdown-copy=");
    expect(partialHtml).toContain("Streaming %[tool: T3 &gt; delegate_task");

    const completedHtml = renderHtml("Streaming %[tool: T3 > delegate_task]");
    expect(completedHtml).toContain('data-markdown-copy="%[tool: T3 &gt; delegate_task]"');
  });

  it("does not transform %[...] inside inline code spans or fenced code blocks", () => {
    const html = renderHtml(
      [
        "Inline `%[tool: T3 > delegate_task]` and `%[model: claudeAgent/claude-opus-4-6, effort=max]` stay raw.",
        "",
        "```txt",
        "%[tool: T3 > delegate_task]",
        "%[model: claudeAgent/claude-opus-4-6, effort=max]",
        "```",
      ].join("\n"),
    );

    expect(html).not.toContain("data-markdown-copy=");
    expect(html).toContain('<code data-inline-code="">%[tool: T3 &gt; delegate_task]</code>');
    expect(html).toContain(
      '<code data-inline-code="">%[model: claudeAgent/claude-opus-4-6, effort=max]</code>',
    );
    expect(html).toContain(
      '<pre><code class="language-txt">%[tool: T3 &gt; delegate_task]\n%[model: claudeAgent/claude-opus-4-6, effort=max]\n</code></pre>',
    );
  });
});
