// Automated posts that can't invent facts (DESIGN §14.4). A generator (a template, or an editorial
// run writing prose) returns sections of book ids with short prose; the prose may name catalog
// books only through `[[book:ID]]` shortcodes, and may use a number only if it is in the input.
// Books render as live cards from the catalog, so every fact about a book comes from our data.

import { z } from "zod";
import { shortcodesIn } from "./shortcodes";

const prose = (max: number) => z.string().trim().max(max);

export const autoPostSchema = z
  .object({
    title: z.string().trim().min(8).max(120),
    dek: prose(240),
    sections: z
      .array(
        z
          .object({
            heading: z.string().trim().min(1).max(100),
            intro_md: prose(1_200),
            book_ids: z.array(z.string().min(1).max(40)).max(60),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    outro_md: prose(1_200),
  })
  .strict();
export type AutoPost = z.infer<typeof autoPostSchema>;

export interface AutoPostInput {
  /** The books the generator was given: the only ones the post may show or name. */
  books: { id: string; title: string }[];
  /** Everything else the generator was given (dates, counts); numbers in prose must come from it. */
  facts: unknown;
  minBooks: number;
  /** Other catalog titles that must not appear as bare text either. */
  otherTitles?: string[];
}

const numbersIn = (text: string) =>
  [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,/g, "").replace(/^0+(?=\d)/, ""));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Problems with a generated post; empty means it may publish (§14.4 validator). */
export function validateAutoPost(post: AutoPost, input: AutoPostInput): string[] {
  const errors: string[] = [];
  const ids = new Set(input.books.map((b) => b.id));
  const texts: [string, string][] = [
    ["title", post.title],
    ["dek", post.dek],
    ...post.sections.flatMap((s, i): [string, string][] => [
      [`sections.${i}.heading`, s.heading],
      [`sections.${i}.intro_md`, s.intro_md],
    ]),
    ["outro_md", post.outro_md],
  ];

  const shown = new Set<string>();
  post.sections.forEach((s, i) => {
    if (s.book_ids.length === 0) errors.push(`sections.${i}: no books`);
    for (const id of s.book_ids) {
      if (!ids.has(id)) errors.push(`sections.${i}: ${id} wasn't in the input`);
      else shown.add(id);
    }
  });
  if (shown.size < input.minBooks) errors.push(`only ${shown.size} books; at least ${input.minBooks} needed`);

  const allowedNumbers = new Set(numbersIn(JSON.stringify(input.facts ?? null)));
  for (const b of input.books) for (const n of numbersIn(b.title)) allowedNumbers.add(n);
  const titles = [...input.books.map((b) => b.title), ...(input.otherTitles ?? [])].filter(
    (t) => t.trim().length >= 5,
  );

  for (const [where, text] of texts) {
    for (const code of shortcodesIn(text)) {
      if (code.kind !== "book") errors.push(`${where}: only book shortcodes are allowed`);
      else if (!ids.has(code.ref)) errors.push(`${where}: ${code.ref} wasn't in the input`);
    }
    const bare = text.replace(/\[\[[^\]]{1,300}\]\]/g, " ");
    if (/https?:|www\.|\]\(|<[a-z/!]/i.test(bare)) errors.push(`${where}: no links or HTML`);
    for (const title of titles)
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(title)}($|[^\\p{L}\\p{N}])`, "u").test(bare)) {
        errors.push(`${where}: names "${title}" without a shortcode`);
        break;
      }
    const stray = numbersIn(bare).filter((n) => !allowedNumbers.has(n));
    if (stray.length) errors.push(`${where}: numbers not in the input (${[...new Set(stray)].join(", ")})`);
  }
  return errors;
}

/** The post's markdown: each section's prose, then one live card per book. */
export function autoPostMarkdown(post: AutoPost): string {
  const parts: string[] = [];
  for (const s of post.sections) {
    parts.push(`## ${s.heading.replace(/\n/g, " ")}`);
    if (s.intro_md) parts.push(s.intro_md);
    for (const id of s.book_ids) parts.push(`[[book:${id}]]`);
  }
  if (post.outro_md) parts.push(post.outro_md);
  return parts.join("\n\n");
}
