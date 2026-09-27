import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AppraisalError,
  answerValue,
  appraisalQuestions,
  ingestBook,
  submitAppraisals,
  writeAiScores,
} from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { bookScores, inboxItems, quizDaily, quizTakes, users } from "../src/db/schema";
import {
  announceNewQuizzes,
  attachTakes,
  getQuiz,
  isLive,
  liveQuizzes,
  publishDueQuizzes,
  purgeAnonymousTakes,
  QUIZZES,
  recordTake,
  setQuizStatus,
  takeOutcome,
  takeQuiz,
} from "../src/quiz";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

async function user(id: string, daysOld: number, verified = true) {
  await db.insert(users).values({
    id,
    email: `${id}@example.com`,
    emailVerified: verified,
    createdAt: new Date(Date.now() - daysOld * 86_400_000),
  } as typeof users.$inferInsert);
}

describe("quiz takes", () => {
  it("records a take, counts it, shares only the result, and attaches it on sign-in", async () => {
    const quiz = getQuiz("whats-your-litrpg-class");
    if (!quiz) throw new Error("missing quiz");
    const answers = quiz.questions.map((q) => q.options[0]?.id ?? "a");
    const result = takeQuiz(quiz, answers);
    const id = await recordTake(db, { quiz, answers, outcomeKey: result.outcome.key, source: "share" });
    const second = await recordTake(db, { quiz, answers, outcomeKey: result.outcome.key, partyRef: id });
    expect(id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(await takeOutcome(db, id)).toEqual({ quizSlug: quiz.slug, outcomeKey: result.outcome.key });
    expect(await takeOutcome(db, "../etc")).toBeNull();
    const [daily] = await db.select().from(quizDaily);
    expect(daily).toMatchObject({ takes: 2, parties: 1 });
    await user("u1", 30);
    expect(await attachTakes(db, "u1", [id, second, "nope"])).toBe(2);
    expect(await attachTakes(db, "u1", [id])).toBe(0);
  });

  it("deletes anonymous takes after 90 days but keeps the counts", async () => {
    const quiz = getQuiz("whats-your-litrpg-class");
    if (!quiz) throw new Error("missing quiz");
    const answers = quiz.questions.map(() => "a");
    const id = await recordTake(db, { quiz, answers, outcomeKey: "min-maxer" });
    await db
      .update(quizTakes)
      .set({ createdAt: new Date(Date.now() - 91 * 86_400_000).toISOString() })
      .where(eq(quizTakes.id, id));
    expect(await purgeAnonymousTakes(db)).toBe(1);
    expect(await db.select().from(quizDaily)).toHaveLength(1);
  });

  it("goes live only when the owner says so", async () => {
    expect(await liveQuizzes(db)).toEqual([]);
    await setQuizStatus(db, "whats-your-litrpg-class", "live", "owner");
    expect((await liveQuizzes(db)).map((q) => q.slug)).toEqual(["whats-your-litrpg-class"]);
    await setQuizStatus(db, "whats-your-litrpg-class", "retired", "owner");
    expect(await isLive(db, "whats-your-litrpg-class")).toBe(false);
    await expect(setQuizStatus(db, "nope", "live", "owner")).rejects.toThrow();
  });

  it("asks the owner once about each quiz that ships, and the console decision answers it", async () => {
    expect(await announceNewQuizzes(db)).toBe(QUIZZES.length);
    expect(await announceNewQuizzes(db)).toBe(0);
    await setQuizStatus(db, "whats-your-litrpg-class", "live", "owner");
    const [item] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.dedupeKey, "quiz_ready:whats-your-litrpg-class"));
    expect(item?.status).toBe("approved");
    expect(item?.subjectId).toBe("whats-your-litrpg-class");
    const open = await db.select().from(inboxItems).where(eq(inboxItems.status, "open"));
    expect(open).toHaveLength(QUIZZES.length - 1);
  });

  it("publishes a quiz when its veto window ends, unless the owner retired it", async () => {
    const t0 = new Date("2026-10-01T12:00:00Z");
    await announceNewQuizzes(db, 48, t0);
    await setQuizStatus(db, "which-dcc-character-are-you", "retired", "owner");
    expect(await publishDueQuizzes(db, new Date("2026-10-03T11:00:00Z"))).toEqual([]);
    const published = await publishDueQuizzes(db, new Date("2026-10-03T12:00:00Z"));
    expect(published).toHaveLength(QUIZZES.length - 1);
    expect(published).not.toContain("which-dcc-character-are-you");
    expect(await isLive(db, "whats-your-litrpg-class")).toBe(true);
    expect(await isLive(db, "which-dcc-character-are-you")).toBe(false);
    expect(await publishDueQuizzes(db, new Date("2026-10-04T12:00:00Z"))).toEqual([]);
  });

  it("waits for the owner when auto-publishing is off", async () => {
    await announceNewQuizzes(db, 0);
    expect(await publishDueQuizzes(db, new Date(Date.now() + 365 * 86_400_000))).toEqual([]);
  });
});

describe("appraisals", () => {
  async function aBook() {
    const { bookId } = await ingestBook(
      db,
      { title: "Appraised", authors: [{ name: "Author" }] },
      { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    await writeAiScores(
      db,
      bookId,
      [
        { key: "competent_mc", value: 6, confidence: 0.65 },
        { key: "pacing", value: 5, confidence: 0.85 },
      ],
      5,
    );
    return bookId;
  }

  it("asks about hidden judgment stats first", async () => {
    const bookId = await aBook();
    const qs = await appraisalQuestions(db, bookId);
    expect(qs).toHaveLength(5);
    // Hidden judgment stats with no evidence at all come before one the AI has estimated.
    expect(qs.every((q) => q.kind === "stat")).toBe(true);
    expect(qs.map((q) => q.key)).not.toContain("competent_mc");
    expect(answerValue("less", 5)).toBe(3);
    expect(answerValue("yes", null)).toBe(8);
  });

  it("only lets week-old verified accounts appraise, and never their own books", async () => {
    const bookId = await aBook();
    await user("new", 2);
    await user("unverified", 30, false);
    await user("author", 30);
    const input = { bookId, answers: [{ key: "competent_mc", answer: "yes" as const }], minAppraisals: 5 };
    await expect(submitAppraisals(db, { ...input, userId: "new" })).rejects.toBeInstanceOf(AppraisalError);
    await expect(submitAppraisals(db, { ...input, userId: "unverified" })).rejects.toMatchObject({
      reason: "not_eligible",
    });
    await expect(
      submitAppraisals(db, { ...input, userId: "author", managedAuthorIds: ["a1"], bookAuthorIds: ["a1"] }),
    ).rejects.toMatchObject({ reason: "own_book" });
  });

  it("reveals a judgment stat once enough readers appraise it", async () => {
    const bookId = await aBook();
    for (let k = 0; k < 5; k++) {
      await user(`r${k}`, 60);
      const { revealed } = await submitAppraisals(db, {
        userId: `r${k}`,
        bookId,
        answers: [
          { key: "competent_mc", answer: "yes" },
          { key: "pacing", answer: "more" },
        ],
        shown: { pacing: 5 },
        minAppraisals: 5,
      });
      expect(revealed).toEqual(k === 4 ? ["competent_mc"] : []);
    }
    const rows = await db.select().from(bookScores).where(eq(bookScores.bookId, bookId));
    const competent = rows.find((r) => r.key === "competent_mc");
    expect(competent).toMatchObject({ crowdN: 5, crowdMean: 8, public: true });
    expect(competent?.value).toBeGreaterThan(6.5);
    expect(rows.find((r) => r.key === "pacing")?.crowdMean).toBe(7);
  });

  it("holds a burst of appraisals from new accounts", async () => {
    const bookId = await aBook();
    let held = false;
    for (let k = 0; k < 10; k++) {
      await user(`n${k}`, 8);
      held = (
        await submitAppraisals(db, {
          userId: `n${k}`,
          bookId,
          answers: [{ key: "hype", answer: "yes" }],
          minAppraisals: 5,
        })
      ).held;
    }
    expect(held).toBe(true);
    expect((await db.select().from(inboxItems)).map((i) => i.type)).toContain("appraisal_burst");
  });
});
