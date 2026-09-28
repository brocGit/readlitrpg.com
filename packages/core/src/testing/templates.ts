// Astro drops whitespace that holds a line break when it sits next to a tag or an expression, so a
// "·" separator at the end of a line (or the start of the next) renders glued to its neighbour:
// "RSS ·Release calendar". Tests run this over every template; `{" "}` keeps the space.

/** Line numbers (1-based) where a "·" separator would lose the space on one side. */
export function lostSeparatorSpaces(source: string): number[] {
  const lines = source.split("\n");
  // Only the template: skip the frontmatter between the first two "---" lines.
  const fences = lines.flatMap((l, i) => (l.trim() === "---" ? [i] : []));
  const start = fences.length >= 2 ? (fences[1] ?? 0) + 1 : 0;
  const found: number[] = [];
  for (let i = start; i < lines.length - 1; i++) {
    const here = (lines[i] ?? "").trimEnd();
    const next = (lines[i + 1] ?? "").trim();
    if (here.endsWith("·") && /^[<{]/.test(next)) found.push(i + 1);
    // A closing tag, a self-closing tag or an expression, then "·" on the next line.
    if (next.startsWith("·") && /(<\/[a-z]+>|\/>|\})$/.test(here) && !here.endsWith('{" "}'))
      found.push(i + 2);
  }
  return found;
}
