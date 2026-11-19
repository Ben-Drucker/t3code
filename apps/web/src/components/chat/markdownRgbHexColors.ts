import type { Element, Root, RootContent } from "hast";
import { findRgbHexColors } from "@t3tools/shared/rgbHexColors";

export function rehypeRgbHexColors() {
  function visit(node: Root | Element) {
    if (node.type === "element" && ["a", "code", "pre", "script", "style"].includes(node.tagName))
      return;
    node.children = node.children.flatMap((child): RootContent[] => {
      if (child.type === "element") visit(child);
      if (child.type !== "text") return [child];
      const colors = findRgbHexColors(child.value);
      if (colors.length === 0) return [child];
      const children: RootContent[] = [];
      let offset = 0;
      for (const color of colors) {
        if (offset < color.start)
          children.push({ type: "text", value: child.value.slice(offset, color.start) });
        children.push({
          type: "element",
          tagName: "span",
          properties: {
            className: ["rgb-hex-chip"],
            style: `--rgb-hex-chip-color: ${color.source}`,
          },
          children: [{ type: "text", value: color.source }],
        });
        offset = color.end;
      }
      if (offset < child.value.length)
        children.push({ type: "text", value: child.value.slice(offset) });
      return children;
    }) as Element["children"];
  }
  return visit;
}
