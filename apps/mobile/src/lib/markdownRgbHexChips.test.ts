import { expect, it } from "vite-plus/test";
import { markdownWithRgbHexChips } from "./markdownDocument";

it("decorates RGB prose without replacing literal code, links, or issue references", () => {
  const markdown =
    "Use #5bed2b and **#AD3C1F**, issue #123456, `#abcdef`, or [#abcdef](https://example.com).\n\n```\n#abcdef\n```";
  const { markdown: decorated, rgbChips } = markdownWithRgbHexChips(markdown);
  expect([...rgbChips]).toEqual([
    ["t3-color://rgb/5bed2b", "#5bed2b"],
    ["t3-color://rgb/AD3C1F", "#AD3C1F"],
  ]);
  expect(decorated).toBe(
    markdown
      .replace("#5bed2b", "[#5bed2b](t3-color://rgb/5bed2b)")
      .replace("#AD3C1F", "[#AD3C1F](t3-color://rgb/AD3C1F)"),
  );
});
