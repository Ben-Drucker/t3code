import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  it("clears the active result while async results are empty and resolves against restored results", () => {
    const search = {
      highlightedItemId: "second",
      currentSearchKey: "path:src",
      highlightedSearchKey: "path:src",
    };
    const cleared = resolveComposerMenuActiveItemId({ ...search, items: [] });
    expect(cleared).toBeNull();
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        highlightedItemId: cleared,
        items: [{ id: "new-result" }, { id: "second" }],
      }),
    ).toBe("new-result");
  });

  it("skips agent-section headers when preferActionableItem is set", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items: [
          { id: 'agent-section:"T3"', type: "agent-section" },
          { id: 'agent-tool:["T3","delegate_task"]', type: "agent-tool" },
        ],
        highlightedItemId: null,
        currentSearchKey: "s:agent-config:t3 delegate",
        highlightedSearchKey: null,
        preferActionableItem: true,
      }),
    ).toBe('agent-tool:["T3","delegate_task"]');
  });
});
