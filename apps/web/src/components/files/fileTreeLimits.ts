import type { ProjectEntry } from "@t3tools/contracts";

/** Rows each folder lists before a "more" row, and how many each click on it adds. */
export const FOLDER_ROW_LIMIT = 200;
/** Expand all stops at this folder depth; deeper folders still open by hand. */
export const EXPAND_ALL_MAX_DEPTH = 6;

// Pierre sorts names by code point, so a name starting with `…` lists after its siblings.
const MORE_ROW_PREFIX = "… ";

export interface MoreRow {
  readonly directory: string;
  readonly hidden: number;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function pathDepth(path: string): number {
  let depth = 1;
  for (const char of path) if (char === "/") depth++;
  return depth;
}

/** `entries` plus every ancestor folder, so each path shows inside its hierarchy. */
export function withAncestors(entries: readonly ProjectEntry[]): ProjectEntry[] {
  const result = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    for (let parent = parentOf(entry.path); parent !== ""; parent = parentOf(parent)) {
      if (result.has(parent)) break;
      result.set(parent, { path: parent, kind: "directory" });
    }
  }
  return [...result.values()];
}

/**
 * Keeps the first `limit` rows of each folder (folders first, then by name) and returns a
 * "more" row for each folder that has others. Search reads the server, so cut rows stay findable.
 */
export function limitFolderRows(
  entries: readonly ProjectEntry[],
  limits: ReadonlyMap<string, number>,
  moreLabel: (hidden: number) => string,
): { entries: ProjectEntry[]; moreRows: Map<string, MoreRow> } {
  const byParent = new Map<string, ProjectEntry[]>();
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(entry);
    else byParent.set(parent, [entry]);
  }
  const kept: ProjectEntry[] = [];
  const moreRows = new Map<string, MoreRow>();
  for (const [parent, siblings] of byParent) {
    const limit = limits.get(parent) ?? FOLDER_ROW_LIMIT;
    if (siblings.length <= limit) {
      kept.push(...siblings);
      continue;
    }
    siblings.sort((left, right) =>
      left.kind !== right.kind
        ? left.kind === "directory"
          ? -1
          : 1
        : left.path.toLowerCase() < right.path.toLowerCase()
          ? -1
          : 1,
    );
    kept.push(...siblings.slice(0, limit));
    const hidden = siblings.length - limit;
    const name = `${MORE_ROW_PREFIX}${moreLabel(hidden)}`;
    const path = parent === "" ? name : `${parent}/${name}`;
    kept.push({ path, kind: "file" });
    moreRows.set(path, { directory: parent, hidden });
  }
  // Rows inside a folder that was cut away would recreate it, so they go too.
  const keptDirectories = new Set(
    kept.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  );
  const visible = kept.filter((entry) => {
    for (let parent = parentOf(entry.path); parent !== ""; parent = parentOf(parent)) {
      if (!keptDirectories.has(parent)) return false;
    }
    return true;
  });
  return { entries: visible, moreRows };
}
