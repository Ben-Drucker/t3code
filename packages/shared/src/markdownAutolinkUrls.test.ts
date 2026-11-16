import { describe, expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { findAutoLinkUrls, remarkAutoLinkUrls } from "./markdownAutolinkUrls.ts";

describe("findAutoLinkUrls", () => {
  it("matches http, https, www, localhost, and safe bare domains", () => {
    expect(
      findAutoLinkUrls(
        "Check https://example.com/path?a=1#b, http://foo.org, www.github.com/org/repo, localhost:3000/api, and docs.python.org/3/!",
      ),
    ).toEqual([
      {
        start: 6,
        end: 36,
        text: "https://example.com/path?a=1#b",
        href: "https://example.com/path?a=1#b",
      },
      {
        start: 38,
        end: 52,
        text: "http://foo.org",
        href: "http://foo.org",
      },
      {
        start: 54,
        end: 77,
        text: "www.github.com/org/repo",
        href: "https://www.github.com/org/repo",
      },
      {
        start: 79,
        end: 97,
        text: "localhost:3000/api",
        href: "http://localhost:3000/api",
      },
      {
        start: 103,
        end: 121,
        text: "docs.python.org/3/",
        href: "https://docs.python.org/3/",
      },
    ]);
  });

  it("balances parentheses and ignores file paths and code extensions", () => {
    expect(
      findAutoLinkUrls(
        "See (https://en.wikipedia.org/wiki/Foo_(bar)) and src/app.ts, main.py, Cargo.toml, foo@example.com, /Users/ben/file.txt",
      ),
    ).toEqual([
      {
        start: 5,
        end: 44,
        text: "https://en.wikipedia.org/wiki/Foo_(bar)",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)",
      },
    ]);
  });
});

describe("remarkAutoLinkUrls", () => {
  it("skips inline code, fenced code blocks, and existing markdown links", () => {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkAutoLinkUrls);
    const tree = processor.runSync(
      processor.parse(
        "Visit example.com and `inline.com` and [label](https://already.com)\n\n```\ninside-code.com\n```",
      ),
    );

    const links: string[] = [];
    const visit = (node: { type: string; url?: string; children?: unknown[] }) => {
      if (node.type === "link" && node.url) links.push(node.url);
      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child as typeof node);
      }
    };
    visit(tree);
    expect(links).toEqual(["https://example.com", "https://already.com"]);
  });
});
