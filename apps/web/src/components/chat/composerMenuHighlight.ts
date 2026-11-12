export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string; type?: string }>;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
  preferActionableItem?: boolean;
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }

  if (input.preferActionableItem) {
    const actionable = input.items.find((item) => item.type !== "agent-section");
    if (actionable) {
      return actionable.id;
    }
  }

  return input.items[0]?.id ?? null;
}
