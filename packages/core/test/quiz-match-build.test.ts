import { beforeEach, describe, expect, it } from "vitest";
import { addConfirmation, ingestBook, setVisibility, writeAiScores } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  buildMatrix,
  buildProfile,
  dial,
  indexOfBook,
  loadMatrix,
  match,
  readPointer,
  resetMatrixCache,
  rollbackMatrix,
  searchPublished,
  storeMatrix,
  tagsOf,
} from "../src/match";
import {
  chosenOptions,
  funSignal,
  getQuiz,
  partyComposition,
  QUIZZES,
  QuizAnswerError,
  READER_CLASSES,
  scoreFun,
  takeQuiz,
} from "../src/quiz";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1, TestKV } from "../src/testing";

describe("the quiz engine", () => {
  it("loads the drafted quizzes and the 12 reader classes", () => {
    expect(READER_CLASSES).toHaveLength(12);
    expect(QUIZZES.length).toBeGreaterThanOrEqual(8);
    expect(getQuiz("whats-your-litrpg-class")?.outcomes).toHaveLength(12);
  });

  it("reaches every outcome by its most favorable answers, as the checker does", () => {
    for (const quiz of QUIZZES.filter((q) => q.kind === "fun")) {
      for (const o of quiz.outcomes) {
        const margin = (opt: { points?: Record<string, number> }) => {
          const mine = opt.points?.[o.key] ?? 0;
          const other = Math.max(
            0,
            ...Object.entries(opt.points ?? {})
              .filter(([k]) => k !== o.key)
              .map(([, v]) => v),
          );
          return mine - other;
        };
        const chosen = quiz.questions.map((q) =>
          q.options.reduce((best, opt) => (margin(opt) > margin(best) ? opt : best)),
        );
        expect(scoreFun(quiz, chosen), `${quiz.slug} → ${o.key}`).toBe(o.key);
      }
    }
  });

  it("scores trivia into tiers", () => {
    const trivia = QUIZZES.find((q) => q.kind === "trivia");
    if (!trivia) throw new Error("no trivia quiz");
    const right = trivia.questions.map((q) => q.options.find((o) => o.correct)?.id ?? "");
    const wrong = trivia.questions.map((q) => q.options.find((o) => !o.correct)?.id ?? "");
    const top = takeQuiz(trivia, right);
    const bottom = takeQuiz(trivia, wrong);
    expect(top.score).toBe(trivia.questions.length);
    expect(top.outcome.key).toBe(trivia.outcomes.at(-1)?.key);
    expect(bottom.outcome.key).toBe(trivia.outcomes[0]?.key);
  });

  it("turns answers into low-importance taste signal blended with the result's seed", () => {
    const signal = funSignal(
      [
        {
          id: "a",
          label: "x",
          effects: { dials: { crunch: 2, pacing: -1 }, stats: { build_payoff: 1 }, tags: { stats: 1 } },
        },
        { id: "b", label: "y", effects: { dials: { crunch: 2 } } },
      ],
      undefined,
    );
    // target = clamp(5 + 1.25·s), importance = min(1, |s|/4)·0.3 (QUIZZES §2.3)
    expect(signal.dials.crunch).toEqual({ target: 10, importance: 0.3 });
    expect(signal.dials.pacing).toEqual({ target: 3.75, importance: 0.075 });
    expect(signal.stats.build_payoff?.floor).toBe(6.5);
    expect(signal.stats.build_payoff?.importance).toBeCloseTo(0.1);
    expect(signal.tags.stats).toBe(1);
    const minMaxer = READER_CLASSES.find((c) => c.key === "min-maxer");
    const seeded = funSignal([], minMaxer?.profile_seed);
    expect(seeded.dials.crunch?.target).toBe(8);
  });

  it("refuses incomplete or unknown answers", () => {
    const quiz = getQuiz("whats-your-litrpg-class");
    if (!quiz) throw new Error("missing quiz");
    expect(() => chosenOptions(quiz, ["a"])).toThrow(QuizAnswerError);
    expect(() =>
      chosenOptions(
        quiz,
        quiz.questions.map(() => "z"),
      ),
    ).toThrow(/no option/);
  });

  it("describes a party of two results", () => {
    const [a, b] = READER_CLASSES;
    if (!a || !b) throw new Error("no classes");
    expect(partyComposition(a, b)).toMatch(new RegExp(`${a.name} \\+ ${b.name}`));
    expect(partyComposition(a, a)).toMatch(/^Two /);
  });
});

describe("building the model from the catalog", () => {
  let db: Db;
  beforeEach(async () => {
    db = createDb(createTestD1().asD1());
    await syncTaxonomy(db);
    resetMatrixCache();
  });

  async function published(
    title: string,
    author: string,
    dials: Record<string, number>,
    tagSlugs: string[],
    genre = "litrpg",
  ) {
    const { bookId } = await ingestBook(
      db,
      {
        title,
        authors: [{ name: author }],
        primaryGenre: genre,
        tags: tagSlugs.map((slug) => ({ slug })),
        confidence: 0.85,
      },
      { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    await writeAiScores(
      db,
      bookId,
      Object.entries(dials).map(([key, value]) => ({ key, value, confidence: 0.85 })),
      5,
    );
    await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
    await setVisibility(db, bookId, "published");
    return bookId;
  }

  it("builds, stores, loads and matches; drafts stay out", async () => {
    const a = await published("Crunch Tower", "Ann", { crunch: 9, pacing: 7 }, [
      "tower-climbing",
      "build-crafting",
    ]);
    const b = await published("Crunch Depths", "Bea", { crunch: 8, pacing: 8 }, [
      "dungeon-crawler",
      "build-crafting",
    ]);
    await published("Soft Farm", "Cid", { crunch: 1, pacing: 2 }, ["farming", "cozy"]);
    await ingestBook(
      db,
      { title: "Draft Only", authors: [{ name: "Dee" }] },
      { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );

    const m = await buildMatrix(db);
    expect(m.n).toBe(3);
    const idx = indexOfBook(m);
    const ai = idx.get(a) as number;
    expect(dial(m, ai, m.dials.indexOf("crunch")).value).toBe(9);
    // The primary genre counts as a certain genre tag.
    expect(tagsOf(m, ai).get(m.tags.indexOf("litrpg"))).toBe(1);

    const kv = new TestKV();
    expect((await storeMatrix(kv.asKV(), m)).stored).toBe(true);
    expect((await storeMatrix(kv.asKV(), await buildMatrix(db))).stored).toBe(false); // unchanged catalog
    const loaded = await loadMatrix(kv.asKV());
    expect(loaded?.version).toBe(m.version);
    const r = match(loaded ?? m, buildProfile(loaded ?? m, { loved: [a] }));
    expect(r.bestBets[0] && loaded?.ids[r.bestBets[0].i]).toBe(b);

    // A new book changes the version; rollback returns to the previous one.
    await published("Crunch Again", "Eve", { crunch: 9 }, ["build-crafting"]);
    const next = await buildMatrix(db);
    await storeMatrix(kv.asKV(), next);
    expect((await readPointer(kv.asKV()))?.previous).toEqual([m.version]);
    expect((await rollbackMatrix(kv.asKV()))?.version).toBe(m.version);
    // The rollback holds: a scheduled build doesn't restore the bad version; a forced one does.
    expect((await storeMatrix(kv.asKV(), next)).stored).toBe(false);
    expect((await readPointer(kv.asKV()))?.pinned).toBe(true);
    expect((await storeMatrix(kv.asKV(), next, { force: true })).stored).toBe(true);
    expect((await readPointer(kv.asKV()))?.pinned).toBeUndefined();
    expect((await buildMatrix(db, { includeDrafts: true })).n).toBe(5);
  });

  it("searches published books by title, series or author", async () => {
    await published("The Crunch Tower", "Ann Writer", { crunch: 9 }, ["build-crafting"]);
    await published("Quiet Farm", "Bo Crunchley", { crunch: 2 }, ["cozy"]);
    const hits = await searchPublished(db, "crunch");
    expect(hits.map((h) => h.title).sort()).toEqual(["Quiet Farm", "The Crunch Tower"]);
    expect(hits.find((h) => h.title === "Quiet Farm")?.authors).toBe("Bo Crunchley");
    expect(hits.find((h) => h.title === "Quiet Farm")?.cover).toBeNull();
    expect(await searchPublished(db, "c")).toEqual([]);
  });
});
