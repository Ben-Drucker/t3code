import type { Element, Root } from "hast";
import { expect, it } from "vite-plus/test";

import { linkUserMessageMentions } from "./userMessageMentions";

const text = (value: string) => ({ type: "text" as const, value });
const element = (tagName: string, children: Element["children"], properties = {}): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

it("links file and directory mentions while preserving code and existing links", () => {
  const tree: Root = {
    type: "root",
    children: [
      element("p", [text('Inspect @"src/main.ts" and @"src/components" plus @"My Folder"')]),
      element("p", [
        element("code", [text("@src/code")]),
        text(" "),
        element("a", [text("@src/label")], { href: "https://example.com" }),
      ]),
      element("pre", [element("code", [text("@src/fenced\n")])]),
    ],
  };
  linkUserMessageMentions(tree);
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      text("Inspect "),
      { tagName: "a", properties: { href: "src/main.ts" }, children: [text("src/main.ts")] },
      text(" and "),
      { tagName: "a", properties: { href: "src/components" }, children: [text("src/components")] },
      text(" plus "),
      { tagName: "a", properties: { href: "./My Folder" }, children: [text("My Folder")] },
    ],
  });
  expect(tree.children[1]).toMatchObject({
    children: [
      { tagName: "code", children: [text("@src/code")] },
      text(" "),
      { tagName: "a", properties: { href: "https://example.com" }, children: [text("@src/label")] },
    ],
  });
  expect(tree.children[2]).toMatchObject({
    children: [{ tagName: "code", children: [text("@src/fenced\n")] }],
  });
});
