import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/queries", () => ({
  useComposerPathSearch: ({ query }: { query: string }) => ({
    entries: query === "My Folder" ? [{ path: "My Folder", kind: "directory" }] : [],
    isPending: false,
  }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
  useThreadSearch: () => undefined,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
  useComposerDraftSelection: () => null,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import { useComposerCommandMenu } from "./use-composer-command-menu";

it("/model clears only its trigger and opens the model picker", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onChangeDraftMessage = vi.fn();
  const onOpenModelPicker = vi.fn();
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    const current = useComposerCommandMenu({
      draftMessage: "fix this /mod",
      ownerKey: "draft",
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage,
      onOpenModelPicker,
    });
    useLayoutEffect(() => {
      menu = current;
    }, [current]);
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const model = menu?.items.find((item) => item.id === "cmd:model");
  if (!model) throw new Error("Expected /model in the slash menu");
  await act(async () => menu?.onSelect(model));

  expect(onOpenModelPicker).toHaveBeenCalledOnce();
  expect(onChangeDraftMessage).toHaveBeenCalledWith("fix this ");
  act(() => root.unmount());
});

it("differentiates folder keyboard actions and dismisses at the open position", async () => {
  const onChangeDraftMessage = vi.fn();
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    const current = useComposerCommandMenu({
      draftMessage: "@My Folder",
      ownerKey: "draft",
      environmentId: null,
      projectCwd: "/workspace",
      selectedProviderStatus: null,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage,
      onOpenModelPicker: vi.fn(),
    });
    useLayoutEffect(() => {
      menu = current;
    }, [current]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(menu?.highlightedItemId).toBe("path:My Folder");
    await act(async () => menu?.onPickerKey?.("browse"));
    expect(onChangeDraftMessage).toHaveBeenLastCalledWith("@./My Folder/");
    await act(async () => menu?.onSelectionChange({ start: 10, end: 10 }));
    await act(async () => menu?.onPickerKey?.("select"));
    expect(onChangeDraftMessage).toHaveBeenLastCalledWith("[My Folder](./My%20Folder) ");
    await act(async () => menu?.onPickerKey?.("dismiss"));
    expect(menu?.trigger).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("keeps a literal percent and suppresses the escaped composer menu", async () => {
  const onChangeDraftMessage = vi.fn();
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe() {
    const current = useComposerCommandMenu({
      draftMessage: "%",
      ownerKey: "draft",
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage,
      onOpenModelPicker: vi.fn(),
    });
    useLayoutEffect(() => {
      menu = current;
    }, [current]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    expect(menu?.trigger?.kind).toBe("agent-config");
    await act(async () => expect(menu?.onDraftChange("%%")).toBe("restore"));
    expect(menu?.trigger).toBeNull();
    expect(onChangeDraftMessage).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
