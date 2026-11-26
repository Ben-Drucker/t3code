import type { PiTool, PiToolChoices } from "@t3tools/contracts";
import { piToolPath } from "@t3tools/shared/piToolExposure";

export interface PiToolNode {
  readonly id: string;
  readonly label: string;
  readonly tool: PiTool | null;
  readonly children: ReadonlyArray<PiToolNode>;
}

const SOURCE_ORDER = ["T3", "Pi"];

function sortNodes(nodes: Array<PiToolNode>): Array<PiToolNode> {
  return nodes.toSorted((left, right) => {
    const leftRank = SOURCE_ORDER.indexOf(left.label);
    const rightRank = SOURCE_ORDER.indexOf(right.label);
    if (leftRank !== rightRank) {
      return (
        (leftRank === -1 ? SOURCE_ORDER.length : leftRank) -
        (rightRank === -1 ? SOURCE_ORDER.length : rightRank)
      );
    }
    // Folders before tools, then by name.
    if ((left.tool === null) !== (right.tool === null)) return left.tool === null ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

/** Folds tools into source > group > tool, as `piToolPath` places them. */
export function buildPiToolTree(tools: ReadonlyArray<PiTool>): ReadonlyArray<PiToolNode> {
  interface Mutable {
    id: string;
    label: string;
    tool: PiTool | null;
    children: Map<string, Mutable>;
  }
  const root = new Map<string, Mutable>();
  for (const tool of tools) {
    const path = piToolPath(tool.name);
    let level = root;
    let id = "";
    path.forEach((segment, index) => {
      id = id === "" ? segment : `${id}\u0000${segment}`;
      const leaf = index === path.length - 1;
      const key = leaf ? `tool:${tool.name}` : `group:${segment}`;
      let node = level.get(key);
      if (node === undefined) {
        node = {
          id: leaf ? tool.name : id,
          label: segment,
          tool: leaf ? tool : null,
          children: new Map(),
        };
        level.set(key, node);
      }
      level = node.children;
    });
  }
  const freeze = (nodes: Map<string, Mutable>): Array<PiToolNode> =>
    sortNodes(
      [...nodes.values()].map((node) => ({
        id: node.id,
        label: node.label,
        tool: node.tool,
        children: freeze(node.children),
      })),
    );
  return freeze(root);
}

export function piToolsUnder(node: PiToolNode): ReadonlyArray<PiTool> {
  return node.tool !== null ? [node.tool] : node.children.flatMap(piToolsUnder);
}

/** A choice the thread made, else what the session did on its latest turn. */
export function isPiToolDeferred(tool: PiTool, choices: PiToolChoices): boolean {
  const choice = choices[tool.name];
  return choice === undefined ? !tool.loaded : choice === "deferred";
}

export function piToolsDeferredState(
  tools: ReadonlyArray<PiTool>,
  choices: PiToolChoices,
): "all" | "none" | "some" {
  const deferrable = tools.filter((tool) => tool.deferrable);
  const deferred = deferrable.filter((tool) => isPiToolDeferred(tool, choices)).length;
  return deferred === 0 ? "none" : deferred === deferrable.length ? "all" : "some";
}

export function withPiToolsDeferred(
  choices: PiToolChoices,
  tools: ReadonlyArray<PiTool>,
  deferred: boolean,
): PiToolChoices {
  const next: Record<string, "direct" | "deferred"> = { ...choices };
  for (const tool of tools) {
    if (tool.deferrable) next[tool.name] = deferred ? "deferred" : "direct";
  }
  return next;
}
