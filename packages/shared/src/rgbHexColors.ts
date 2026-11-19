interface RgbHexColor {
  readonly start: number;
  readonly end: number;
  readonly source: string;
}

export function findRgbHexColors(text: string): RgbHexColor[] {
  if (!text.includes("#")) return [];
  const colors: RgbHexColor[] = [];
  for (const { 0: source, index: start } of text.matchAll(
    /(?<![\p{L}\p{N}_/#=&\\-])#[0-9a-f]{6}(?![\p{L}\p{N}_/#-])/giu,
  )) {
    if (
      /^#\d{6}$/.test(source) &&
      /\b(?:issues?|tickets?|PRs?|pull requests?|refs?|fix(?:es|ed)?|clos(?:e[sd]?)|resolv(?:e[sd]?))\s*$/i.test(
        text.slice(Math.max(0, start - 24), start),
      )
    )
      continue;
    colors.push({ start, end: start + source.length, source });
  }
  return colors;
}

export function findComposerRgbHexColors(markdown: string): RgbHexColor[] {
  const colors = findRgbHexColors(markdown);
  if (colors.length === 0 || !/[`~]/.test(markdown)) return colors;
  const code: Array<{ start: number; end: number }> = [];
  let open: { start: number; marker: string } | undefined;
  for (const { 1: marker = "", 2: rest = "", index } of markdown.matchAll(
    /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm,
  )) {
    if (open === undefined) {
      if (marker[0] === "~" || !rest.includes("`")) open = { start: index, marker };
    } else if (marker.startsWith(open.marker) && rest.trim() === "") {
      code.push({ start: open.start, end: index + marker.length });
      open = undefined;
    }
  }
  if (open) code.push({ start: open.start, end: markdown.length });
  const prose = [...code, { start: markdown.length, end: markdown.length }];
  let previous = 0;
  for (const { start, end } of prose) {
    for (const match of markdown
      .slice(previous, start)
      .matchAll(/(?<![\\`])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
      code.push({ start: previous + match.index, end: previous + match.index + match[0].length });
    }
    previous = end;
  }
  return colors.filter(
    (color) => !code.some((range) => range.start <= color.start && color.start < range.end),
  );
}
