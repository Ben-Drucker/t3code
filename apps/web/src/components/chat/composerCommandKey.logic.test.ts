import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { composerCommandKeyHandler } from "./composerCommandKey";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

it.each(["file", "directory"] as const)(
  "selects a highlighted %s with Enter or Tab and sends when the menu closes",
  (kind) => {
    const item: ComposerCommandItem = {
      id: "path:selected",
      type: "path",
      path: "src/example",
      pathKind: kind,
      label: "example",
      description: "src",
      searchTarget: { environmentId: EnvironmentId.make("local"), cwd: "/repo", query: "ex" },
    };
    const menuOpen = { current: true };
    const onSelectComposerItem = vi.fn();
    const submitComposer = vi.fn();
    const handler = composerCommandKeyHandler({
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      sendShortcut: "enter",
      routeKind: "server",
      phase: "ready",
      canSteer: false,
      followUpBehavior: "queue",
      isSoftwareKeyboardOpen: false,
      isLiteralPendingAnswer: false,
      pendingUserInputs: [],
      promptHistoryEntries: [],
      promptHistoryPositionRef: { current: null },
      composerDraftTarget: {
        threadId: ThreadId.make("thread"),
        environmentId: EnvironmentId.make("local"),
      },
      promptRef: { current: "@ex" },
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      composerPreviewAnnotations: [],
      composerReviewComments: [],
      composerEditorRef: { current: null },
      composerMenuOpenRef: menuOpen,
      composerMenuItemsRef: { current: [{ ...item, id: "first" }, item] },
      activeComposerMenuItemRef: { current: item },
      setComposerDraftPrompt: vi.fn(),
      setComposerCursor: vi.fn(),
      setComposerTrigger: vi.fn(),
      setComposerHighlightedItemId: vi.fn(),
      dismissComposerTrigger: vi.fn(),
      nudgeComposerMenuHighlight: vi.fn(),
      onSelectComposerItem,
      resolveActiveComposerTrigger: () => ({ trigger: null }),
      readComposerSnapshot: () => ({ value: "@ex" }),
      applyPromptReplacement: vi.fn(),
      submitComposer,
      promptSuggestion: null,
      dismissPromptSuggestion: vi.fn(),
    });

    for (const key of ["Enter", "Tab"]) {
      expect(handler(key, { key } as KeyboardEvent)).toBe(true);
      expect(onSelectComposerItem).toHaveBeenLastCalledWith(item);
      expect(submitComposer).not.toHaveBeenCalled();
    }
    menuOpen.current = false;
    expect(handler("Enter", { key: "Enter" } as KeyboardEvent)).toBe(true);
    expect(submitComposer).toHaveBeenCalledOnce();
  },
);
