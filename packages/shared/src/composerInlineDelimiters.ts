import { inlineMarkdownUnitMarks } from "./composerRichText";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^\s{0,3}([*_-])(?:\s*\1){2,}\s*$/;
// Quote, list, and heading markers are block syntax the composer never sees inline.
const BLOCK_PREFIX = /^\s*(?:>\s*)*(?:[*+-]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)?/;
// Math, link targets, autolinks, and bare URLs keep their characters as written.
const VERBATIM =
  /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\]\([^)\n]*\)|<[^>\s]+>|\bhttps?:\/\/\S+/g;

function escapeLine(line: string): string {
  const prefix = line.match(BLOCK_PREFIX)?.[0] ?? "";
  const body = line.slice(prefix.length);
  if (!/[*~`]/.test(body)) return line;
  const marks = inlineMarkdownUnitMarks(body);
  const verbatim = new Uint8Array(body.length);
  for (const match of body.matchAll(VERBATIM)) {
    verbatim.fill(1, match.index, match.index + match[0].length);
  }
  let out = prefix;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char === "\\") {
      out += body.slice(index, index + 2);
      index++;
      continue;
    }
    if (char === "`") {
      let end = index;
      while (body[end] === "`") end++;
      const run = body.slice(index, end);
      out += run.length === 1 && marks[index] !== null && !verbatim[index] ? "\\`" : run;
      index = end - 1;
      continue;
    }
    out +=
      (char === "*" || char === "~") && marks[index] !== null && !verbatim[index]
        ? `\\${char}`
        : char;
  }
  return out;
}

/**
 * Escapes the `*`, `~`, and single-backtick delimiters that the composer would show as text, so
 * rendered Markdown styles only the spans the composer styles and never pairs across lines.
 */
export function escapeNonComposerDelimiters(markdown: string): string {
  if (!/[*~`]/.test(markdown)) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opener = line.match(FENCE)?.[1];
      if (fence !== null) {
        if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
        return line;
      }
      if (opener) {
        fence = opener;
        return line;
      }
      if (/^(?: {4}|\t)/.test(line) || THEMATIC_BREAK.test(line)) return line;
      return escapeLine(line);
    })
    .join("\n");
}
