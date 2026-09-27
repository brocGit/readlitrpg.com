// Small hand-built catalogs for match tests.

import { assembleMatrix, type MatrixBookInput } from "../../src/match";

type Partial2 = Partial<Omit<MatrixBookInput, "dials" | "stats">> & {
  id: string;
  dials?: Record<string, number>;
  stats?: Record<string, number>;
  publicStats?: string[];
};

export function book(b: Partial2): MatrixBookInput {
  return {
    slug: b.id,
    seriesId: null,
    seriesPosition: null,
    seriesStatus: null,
    authorIds: [`author-${b.id}`],
    harem: "none",
    contentFlags: [],
    formats: ["ebook"],
    kindleUnlimited: false,
    aiUse: "unknown",
    inScope: "yes",
    crunchLevel: null,
    romanceLevel: 0,
    year: 2020,
    quality: 0.5,
    tags: {},
    embedding: null,
    ...b,
    dials: Object.fromEntries(
      Object.entries(b.dials ?? {}).map(([k, v]) => [k, { value: v, confidence: 0.85 }]),
    ),
    stats: Object.fromEntries(
      Object.entries(b.stats ?? {}).map(([k, v]) => [
        k,
        { value: v, confidence: 0.85, public: (b.publicStats ?? []).includes(k) },
      ]),
    ),
  };
}

/** A tiny catalog with clear clusters: crunchy dungeon crawls, cozy crafting, grim cultivation. */
export function catalog() {
  const crunchy = { crunch: 9, strategy: 9, rigour: 8, pacing: 7, combat: 8, tone: 5, humor: 4 };
  const cozy = { crunch: 2, strategy: 3, rigour: 3, pacing: 2, combat: 2, tone: 9, humor: 7 };
  const grim = { crunch: 1, strategy: 6, rigour: 5, pacing: 6, combat: 7, tone: 1, humor: 1 };
  return assembleMatrix(
    [
      book({
        id: "delve-1",
        seriesId: "delve",
        seriesPosition: 1,
        seriesStatus: "ongoing",
        authorIds: ["ss"],
        dials: crunchy,
        stats: { build_payoff: 9, competent_mc: 8 },
        publicStats: ["build_payoff"],
        tags: { "dungeon-crawler": 0.9, "build-crafting": 0.9, stats: 0.9, litrpg: 1 },
      }),
      book({
        id: "delve-2",
        seriesId: "delve",
        seriesPosition: 2,
        seriesStatus: "ongoing",
        authorIds: ["ss"],
        dials: crunchy,
        stats: { build_payoff: 9, competent_mc: 8 },
        tags: { "dungeon-crawler": 0.9, "build-crafting": 0.9, stats: 0.9, litrpg: 1 },
      }),
      book({
        id: "crawler-1",
        seriesId: "crawler",
        seriesPosition: 1,
        authorIds: ["cw"],
        dials: { ...crunchy, humor: 8 },
        stats: { build_payoff: 8, competent_mc: 7 },
        tags: { "dungeon-crawler": 0.9, humorous: 0.8, litrpg: 1 },
        formats: ["ebook", "audiobook"],
        kindleUnlimited: true,
      }),
      book({
        id: "min-max",
        authorIds: ["ss"],
        dials: { ...crunchy, pacing: 9 },
        stats: { build_payoff: 8, competent_mc: 3, fast_start: 2 },
        publicStats: ["competent_mc", "fast_start"],
        tags: { "build-crafting": 0.9, "system-exploitation": 0.8, "tower-climbing": 0.9, litrpg: 1 },
      }),
      book({
        id: "harem-crunch",
        authorIds: ["hc"],
        harem: "harem",
        romanceLevel: 3,
        dials: crunchy,
        tags: { "dungeon-crawler": 0.8, litrpg: 1 },
      }),
      book({
        id: "unknown-harem",
        authorIds: ["uh"],
        harem: "unknown",
        dials: crunchy,
        tags: { "dungeon-crawler": 0.8, litrpg: 1 },
      }),
      book({
        id: "cozy-1",
        seriesId: "cozy",
        seriesPosition: 1,
        seriesStatus: "complete",
        authorIds: ["cz"],
        dials: cozy,
        stats: { low_drama: 9 },
        tags: { cozy: 0.9, crafting: 0.9, farming: 0.8, "slice-of-life": 0.7, litrpg: 1 },
        formats: ["ebook", "audiobook"],
      }),
      book({
        id: "cozy-2",
        seriesId: "cozy",
        seriesPosition: 2,
        seriesStatus: "complete",
        authorIds: ["cz"],
        dials: cozy,
        stats: { low_drama: 9 },
        tags: { cozy: 0.9, crafting: 0.9, litrpg: 1 },
      }),
      book({
        id: "shop",
        authorIds: ["sh"],
        dials: { ...cozy, humor: 5 },
        tags: { cozy: 0.8, business: 0.9, crafting: 0.7, grimdark: 0.25, litrpg: 1 },
      }),
      book({
        id: "grim-1",
        authorIds: ["gr"],
        dials: grim,
        contentFlags: ["gore", "graphic-violence"],
        tags: { cultivation: 0.9, grimdark: 0.9, "villain-mc": 0.8, "progression-fantasy": 1 },
        aiUse: "ai_generated",
      }),
      book({
        id: "grim-2",
        authorIds: ["gr2"],
        dials: grim,
        tags: { cultivation: 0.9, grimdark: 0.7, "progression-fantasy": 1 },
      }),
      book({ id: "sparse", authorIds: ["sp"], tags: { "system-apocalypse": 0.9, litrpg: 1 } }),
    ],
    "test-1",
    "2026-09-27T00:00:00.000Z",
  );
}
