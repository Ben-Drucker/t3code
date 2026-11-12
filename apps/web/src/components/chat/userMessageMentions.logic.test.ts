import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, it } from "vite-plus/test";

import { remarkUserMessageMentions } from "./userMessageMentions";

it("links file and directory mentions while preserving code and existing links", () => {
  const tree = fromMarkdown(
    'Inspect @"src/main.ts" and @"src/components" plus @"My Folder"\n\n' +
      "`@src/code` [@src/label](https://example.com)\n\n```\n@src/fenced\n```",
  );
  remarkUserMessageMentions()(tree);
  expect(tree.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "Inspect " },
      { type: "link", url: "src/main.ts", children: [{ type: "text", value: "src/main.ts" }] },
      { type: "text", value: " and " },
      {
        type: "link",
        url: "src/components",
        children: [{ type: "text", value: "src/components" }],
      },
      { type: "text", value: " plus " },
      { type: "link", url: "./My Folder", children: [{ type: "text", value: "My Folder" }] },
    ],
  });
  expect(tree.children[1]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "inlineCode", value: "@src/code" },
      { type: "text", value: " " },
      {
        type: "link",
        url: "https://example.com",
        children: [{ type: "text", value: "@src/label" }],
      },
    ],
  });
  expect(tree.children[2]).toMatchObject({ type: "code", value: "@src/fenced" });
});
