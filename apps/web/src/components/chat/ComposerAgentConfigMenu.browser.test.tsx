import { formatAgentToolChip } from "@t3tools/shared/composerInlineTokens";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { canOpenAgentConfigTrigger } from "../../composer-logic";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { buildAgentToolSections, matchesAgentModelRow } from "./agentToolMenu";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

const TOOL_GROUPS = [
  {
    source: "T3",
    kind: "t3" as const,
    status: "ready" as const,
    tools: [
      { name: "delegate_task", description: "Delegate work to a subagent" },
      { name: "task_status", description: "Check task progress" },
    ],
  },
];

function buildItems(query: string): ComposerCommandItem[] {
  const items: ComposerCommandItem[] = matchesAgentModelRow(query)
    ? [
        {
          id: "agent-model",
          type: "agent-model",
          label: "Model",
          description: "Choose a model and its options",
        },
      ]
    : [];
  for (const section of buildAgentToolSections(TOOL_GROUPS, query, new Map())) {
    items.push({
      id: section.id,
      type: "agent-section",
      source: section.group.source,
      kind: section.group.kind,
      status: section.group.status,
      toolCount: section.group.tools.length,
      expanded: section.expanded,
      label: section.group.source,
      description: "",
    });
    if (!section.expanded) continue;
    for (const tool of section.tools) {
      items.push({
        id: `agent-tool:${JSON.stringify([section.group.source, tool.name])}`,
        type: "agent-tool",
        source: section.group.source,
        tool: tool.name,
        status: section.group.status,
        deferred: false,
        label: `${section.group.source} > ${tool.name}`,
        description: tool.description ?? "",
      });
    }
  }
  return items;
}

function Harness() {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState({ value: "", cursor: 0 });
  const [menu, setMenu] = useState<{
    readonly insertAt: number;
    readonly cursor: number;
    readonly query: string;
  } | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const items = menu ? buildItems(menu.query) : [];
  const searchKey = menu ? `agent-config:${menu.query.trim().toLowerCase()}` : null;
  const activeItemId = menu
    ? resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: highlightedId,
        currentSearchKey: searchKey,
        highlightedSearchKey: searchKey,
        preferActionableItem: menu.query.trim() !== "",
      })
    : null;
  const activeItem = items.find((item) => item.id === activeItemId) ?? null;

  const dismiss = (options: { readonly restoreFocus: boolean }) => {
    const prev = menu;
    setMenu(null);
    setHighlightedId(null);
    if (options.restoreFocus && prev) {
      editorRef.current?.focusAt(prev.cursor);
    }
  };

  const selectItem = (item: ComposerCommandItem) => {
    if (!menu || item.type !== "agent-tool" || item.tool === null) return;
    const chip = `${formatAgentToolChip({ source: item.source, tool: item.tool })} `;
    const nextValue = `${prompt.value.slice(0, menu.insertAt)}${chip}${prompt.value.slice(menu.insertAt)}`;
    const nextCursor = menu.insertAt + chip.length;
    flushSync(() => {
      setPrompt({ value: nextValue, cursor: nextCursor });
      setMenu(null);
      setHighlightedId(null);
    });
    editorRef.current?.focusAt(nextCursor);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      selectItem(activeItem);
    }
  };

  return (
    <div>
      <button type="button">Outside target</button>
      {menu ? (
        <ComposerCommandMenu
          listId="test-agent-config-list"
          items={items}
          resolvedTheme="dark"
          isLoading={false}
          triggerKind="agent-config"
          agentToolQuery={menu.query}
          onAgentToolQueryChange={(query) => {
            setHighlightedId(null);
            setMenu((prev) => (prev ? { ...prev, query } : null));
          }}
          onAgentToolQueryKeyDown={onKeyDown}
          onDismissAgentToolMenu={dismiss}
          activeItemId={activeItemId}
          onHighlightedItemChange={setHighlightedId}
          onSelect={selectItem}
        />
      ) : null}
      <ComposerPromptEditor
        editorRef={editorRef}
        ariaLabel="Message"
        value={prompt.value}
        cursor={prompt.cursor}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(value, cursor) => setPrompt({ value, cursor })}
        onPaste={() => {}}
        onOpenAgentConfigMenu={() => {
          const snap = editorRef.current?.readSnapshot();
          if (!snap || !canOpenAgentConfigTrigger(snap.value, snap.expandedCursor)) {
            return false;
          }
          setHighlightedId(null);
          setMenu({
            insertAt: snap.expandedCursor,
            cursor: snap.cursor,
            query: "",
          });
          return true;
        }}
      />
      <output data-testid="prompt-value">{prompt.value}</output>
    </div>
  );
}

describe("Composer % agent config menu", () => {
  it("opens on %, focuses search without inserting %, supports multi-word queries, and inserts a tool chip", async () => {
    const screen = await render(<Harness />);
    try {
      const editor = screen.container.querySelector<HTMLElement>('[contenteditable="true"]')!;
      await userEvent.click(editor);
      await userEvent.keyboard("Run %");

      expect(screen.getByTestId("prompt-value").element().textContent).toBe("Run ");
      const searchInput = screen.container.querySelector<HTMLInputElement>(
        'input[aria-label="Search tools"]',
      );
      expect(searchInput).not.toBeNull();
      expect(document.activeElement).toBe(searchInput);

      await userEvent.keyboard("t3 delegate{Enter}");

      expect(screen.container.querySelector('input[aria-label="Search tools"]')).toBeNull();
      expect(screen.getByTestId("prompt-value").element().textContent).toBe(
        "Run %[tool: T3 > delegate_task] ",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("dismisses cleanly on Escape, outside click, and allows literal 50% without opening", async () => {
    const screen = await render(<Harness />);
    try {
      const editor = screen.container.querySelector<HTMLElement>('[contenteditable="true"]')!;
      await userEvent.click(editor);
      await userEvent.keyboard("50% ");

      expect(screen.container.querySelector('input[aria-label="Search tools"]')).toBeNull();
      expect(screen.getByTestId("prompt-value").element().textContent).toBe("50% ");

      await userEvent.keyboard("%");
      const searchInput = screen.container.querySelector<HTMLInputElement>(
        'input[aria-label="Search tools"]',
      );
      expect(searchInput).not.toBeNull();
      expect(document.activeElement).toBe(searchInput);

      await userEvent.keyboard("task status{Escape}");
      expect(screen.container.querySelector('input[aria-label="Search tools"]')).toBeNull();
      expect(screen.getByTestId("prompt-value").element().textContent).toBe("50% ");
      expect(editor.contains(document.activeElement) || document.activeElement === editor).toBe(
        true,
      );

      await userEvent.keyboard("%");
      expect(screen.container.querySelector('input[aria-label="Search tools"]')).not.toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Outside target" }));
      expect(screen.container.querySelector('input[aria-label="Search tools"]')).toBeNull();
      expect(screen.getByTestId("prompt-value").element().textContent).toBe("50% ");
    } finally {
      await screen.unmount();
    }
  });
});
