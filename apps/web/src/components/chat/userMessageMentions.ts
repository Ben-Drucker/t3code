import type { PhrasingContent, Root, RootContent } from "mdast";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { isRelativeFilePath, parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";

export function remarkUserMessageMentions() {
  return (tree: Root) => {
    const visit = (node: { type: string; children?: Array<RootContent | PhrasingContent> }) => {
      if (node.type === "link" || node.type === "linkReference") return;
      const children = node.children;
      if (!children) return;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index]!;
        if (child.type !== "text") {
          visit(child);
          continue;
        }
        const mentions = collectComposerInlineTokens(`${child.value} `).filter(
          (token) => token.type === "mention" && token.source.startsWith("@"),
        );
        if (mentions.length === 0) continue;
        const replacement: PhrasingContent[] = [];
        let offset = 0;
        for (const mention of mentions) {
          if (mention.start > offset) {
            replacement.push({ type: "text", value: child.value.slice(offset, mention.start) });
          }
          replacement.push({
            type: "link",
            url:
              !parseMarkdownFileLink(mention.value) && isRelativeFilePath(mention.value)
                ? `./${mention.value}`
                : mention.value,
            children: [{ type: "text", value: mention.value }],
          });
          offset = mention.end;
        }
        if (offset < child.value.length) {
          replacement.push({ type: "text", value: child.value.slice(offset) });
        }
        children.splice(index, 1, ...replacement);
      }
    };
    visit(tree);
  };
}
