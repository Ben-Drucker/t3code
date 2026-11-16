import type { Link, PhrasingContent, Root, Text } from "mdast";
import type { Transformer } from "unified";

export interface AutoLinkedUrlMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly href: string;
}

// Excludes common code/file extensions (.ts, .js, .py, .rs, .go, .sh, .md, .json, etc.).
const SAFE_WEB_TLDS =
  "com|org|net|io|dev|app|ai|co|edu|gov|me|tv|uk|de|fr|ca|au|jp|in|nl|ch|se|no|eu|us|info|biz|xyz|tech|cloud|codes|so|to|gg|fm|ly|it|is";

const AUTO_LINK_URL_REGEX = new RegExp(
  `(?:https?:\\/\\/[^\\s<>]+|www\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}(?![\\p{L}\\p{N}_-])(?::\\d{1,5})?(?:[/?#][^\\s<>]*)?|(?:localhost|127\\.0\\.0\\.1):\\d{1,5}(?![\\p{L}\\p{N}_-])(?:[/?#][^\\s<>]*)?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${SAFE_WEB_TLDS})(?![\\p{L}\\p{N}_-])(?::\\d{1,5})?(?:[/?#][^\\s<>]*)?)`,
  "giu",
);

const INVALID_PREFIX_CHAR = /[\p{L}\p{N}/\\._@~:=+-]/u;
const TRAILING_PUNCTUATION = /[.,;:!?'"`]+$/;

function countChar(value: string, target: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === target) count += 1;
  }
  return count;
}

function trimTrailingDelimiters(raw: string): string {
  let value = raw.replace(TRAILING_PUNCTUATION, "");
  while (value.length > 0) {
    const last = value[value.length - 1];
    if (last === ")" && countChar(value, ")") > countChar(value, "(")) {
      value = value.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
      continue;
    }
    if (last === "]" && countChar(value, "]") > countChar(value, "[")) {
      value = value.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
      continue;
    }
    if (last === "}" && countChar(value, "}") > countChar(value, "{")) {
      value = value.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
      continue;
    }
    break;
  }
  return value;
}

function toHref(matched: string): string {
  if (/^https?:\/\//i.test(matched)) return matched;
  if (/^(?:localhost|127\.0\.0\.1):/i.test(matched)) return `http://${matched}`;
  return `https://${matched}`;
}

export function findAutoLinkUrls(text: string): ReadonlyArray<AutoLinkedUrlMatch> {
  const matches: AutoLinkedUrlMatch[] = [];
  AUTO_LINK_URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AUTO_LINK_URL_REGEX.exec(text)) !== null) {
    const start = match.index;
    if (start > 0 && INVALID_PREFIX_CHAR.test(text[start - 1]!)) {
      continue;
    }
    const trimmed = trimTrailingDelimiters(match[0]);
    if (trimmed.length === 0) continue;
    // Reject scheme-only matches like "https://" with no host.
    if (/^https?:\/\/$/i.test(trimmed)) continue;
    matches.push({
      start,
      end: start + trimmed.length,
      text: trimmed,
      href: toHref(trimmed),
    });
  }
  return matches;
}

function splitTextNodeWithUrls(node: Text): PhrasingContent[] | null {
  const matches = findAutoLinkUrls(node.value);
  if (matches.length === 0) return null;

  const replacement: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      replacement.push({ type: "text", value: node.value.slice(cursor, match.start) });
    }
    const link: Link = {
      type: "link",
      url: match.href,
      children: [{ type: "text", value: match.text }],
    };
    replacement.push(link);
    cursor = match.end;
  }
  if (cursor < node.value.length) {
    replacement.push({ type: "text", value: node.value.slice(cursor) });
  }
  return replacement;
}

const SKIP_PARENTS = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
  "image",
  "imageReference",
]);

function visitAutolinkNodes(node: { type: string; children?: unknown[] }): void {
  if (SKIP_PARENTS.has(node.type) || !Array.isArray(node.children)) {
    return;
  }
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i] as { type: string; value?: string; children?: unknown[] };
    if (child.type === "text" && typeof child.value === "string") {
      const replacement = splitTextNodeWithUrls(child as Text);
      if (replacement) {
        node.children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
      continue;
    }
    visitAutolinkNodes(child);
  }
}

export function remarkAutoLinkUrls(): Transformer<Root> {
  return (tree) => {
    visitAutolinkNodes(tree);
  };
}
