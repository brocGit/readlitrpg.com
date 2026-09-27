// Link-preview images (DESIGN §7.10 "Social image generation", §17.2): PNGs rendered by the jobs
// Worker into MEDIA. Keys are derived from what's on the card, so a page can point at its image
// without asking whether it exists, and a changed card gets a new URL that no platform has cached.

import { QUIZ_HASH } from "../quiz/quizzes.gen";

/** Bump when a card's layout changes, so every card is drawn again. */
export const OG_VERSION = 1;

export const siteOgKey = () => `og/site/v${OG_VERSION}.png`;
export const classOgKey = (classKey: string) => `og/class/${QUIZ_HASH}-${OG_VERSION}/${classKey}.png`;
export const quizOgKey = (slug: string, outcome: string) =>
  `og/quiz/${QUIZ_HASH}-${OG_VERSION}/${slug}/${outcome}.png`;

export interface BookCardInput {
  id: string;
  title: string;
  authors: string[];
  series: { name: string; position: number | null } | null;
  hook: string | null;
  genre: string | null;
  coverKey: string | null;
}

/** "og/book/{id}/{hash}.png": the hash covers everything drawn on the card. */
export async function bookOgKey(b: BookCardInput): Promise<string> {
  const text = JSON.stringify([OG_VERSION, b.title, b.authors, b.series, b.hook, b.genre, b.coverKey]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `og/book/${b.id}/${hex.slice(0, 12)}.png`;
}

// ---------------------------------------------------------------------------------------------
// What each card says. The site's SVG cards and the jobs Worker's PNGs are drawn from the same
// text, so a shared link previews exactly what the page shows.

export interface CardText {
  kicker: string;
  title: string;
  subtitle?: string;
  lines?: string[];
  footer?: string;
}

export const siteCardText = (): CardText => ({
  kicker: "LitRPG discovery",
  title: "Tell it the books you loved.",
  subtitle: "It finds your next LitRPG, progression fantasy or cultivation read.",
  footer: "readlitrpg.com",
});

export function classCardText(
  cls: { name: string; tagline: string },
  extra: { musts?: string[]; noes?: string[] } = {},
): CardText {
  return {
    kicker: "Reader class",
    title: cls.name,
    subtitle: cls.tagline,
    lines: [
      extra.musts?.length ? `Must-haves: ${extra.musts.join(", ")}` : "",
      extra.noes?.length ? `Hard no: ${extra.noes.join(", ")}` : "",
    ].filter(Boolean),
    footer: "Find yours at readlitrpg.com/match",
  };
}

export function quizCardText(
  quiz: { slug: string; title: string },
  outcome: { name: string; tagline: string; loves?: string[] },
): CardText {
  return {
    kicker: quiz.title,
    title: outcome.name,
    subtitle: outcome.tagline,
    lines: (outcome.loves ?? []).slice(0, 3).map((l) => `+ ${l}`),
    footer: `readlitrpg.com/quiz/${quiz.slug}`,
  };
}
