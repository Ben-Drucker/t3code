import type { Element, ElementContent, Root } from "hast";

// Agents write `~5 min and ~10 min` for estimates, so a short single-tilde span is prose.
const MIN_SINGLE_TILDE_STRIKE_CHARS = 101;

const SKIP = new Set(["code", "pre", "kbd", "samp", "script", "style", "math"]);
// GFM flanking: the opener is not followed by whitespace and the closer not preceded by it.
const SPAN = /(?<!~)~(?![\s~])([^~]+?)(?<![\s~])~(?!~)/g;

/** Strikes `~text~` spans longer than 100 characters; Words parses only `~~text~~` here. */
export function strikeLongSingleTildeSpans(node: Root | Element): void {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type === "element") {
      if (!SKIP.has(child.tagName)) strikeLongSingleTildeSpans(child);
      continue;
    }
    if (child.type !== "text" || !child.value.includes("~")) continue;
    const parts: ElementContent[] = [];
    let last = 0;
    for (const match of child.value.matchAll(SPAN)) {
      const inner = match[1]!;
      if (inner.length < MIN_SINGLE_TILDE_STRIKE_CHARS) continue;
      if (match.index > last)
        parts.push({ type: "text", value: child.value.slice(last, match.index) });
      parts.push({
        type: "element",
        tagName: "del",
        properties: {},
        children: [{ type: "text", value: inner }],
      });
      last = match.index + match[0].length;
    }
    if (parts.length === 0) continue;
    if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
    children.splice(index, 1, ...parts);
    index += parts.length - 1;
  }
}
