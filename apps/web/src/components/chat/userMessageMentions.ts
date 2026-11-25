import type { Element, ElementContent, Root } from "hast";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { isRelativeFilePath, parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";

const SKIPPED_TAGS = new Set(["a", "code", "pre"]);

/** Links a sent message's `@path` mentions, outside code and links, to the files they name. */
export function linkUserMessageMentions(tree: Root | Element) {
  const children = tree.children;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    if (child.type === "element") {
      if (!SKIPPED_TAGS.has(child.tagName)) linkUserMessageMentions(child);
      continue;
    }
    if (child.type !== "text") continue;
    const mentions = collectComposerInlineTokens(`${child.value} `).filter(
      (token) => token.type === "mention" && token.source.startsWith("@"),
    );
    if (mentions.length === 0) continue;
    const replacement: ElementContent[] = [];
    let offset = 0;
    for (const mention of mentions) {
      if (mention.start > offset) {
        replacement.push({ type: "text", value: child.value.slice(offset, mention.start) });
      }
      replacement.push({
        type: "element",
        tagName: "a",
        properties: {
          href:
            !parseMarkdownFileLink(mention.value) && isRelativeFilePath(mention.value)
              ? `./${mention.value}`
              : mention.value,
        },
        children: [{ type: "text", value: mention.value }],
      });
      offset = mention.end;
    }
    if (offset < child.value.length) {
      replacement.push({ type: "text", value: child.value.slice(offset) });
    }
    (children as ElementContent[]).splice(index, 1, ...replacement);
  }
}
