// Small text formatters shared by pages and islands (no server imports, so islands can use them).

/**
 * An author line that fits a card: every name up to three, then the first two and a count
 * ("Ann Writer, Bo Scribe and 11 more"). Anthologies and big collaborations used to push a tile's
 * title and hook far down the card. The book page still lists everyone.
 */
export function authorLine(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  const shown = Math.max(1, max - 1);
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}
