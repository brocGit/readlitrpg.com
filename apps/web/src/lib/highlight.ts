// Marks the words of a search in a result, so a reader sees why it matched (DESIGN §9.10). Returns
// plain parts for the template to wrap: nothing here builds HTML, so a title can't inject markup.

export interface Part {
  text: string;
  hit: boolean;
}

export function highlight(text: string, query: string): Part[] {
  const words = [...new Set(query.toLowerCase().split(/\s+/))]
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length >= 2)
    // Longest first, so "tower" wins over "to" where both match.
    .sort((a, b) => b.length - a.length);
  if (words.length === 0) return [{ text, hit: false }];
  const pattern = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu",
  );
  return text
    .split(pattern)
    .filter((t) => t !== "")
    .map((t) => ({ text: t, hit: words.includes(t.toLowerCase()) }));
}
