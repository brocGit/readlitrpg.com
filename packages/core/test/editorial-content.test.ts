import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createProfile } from "../src/authors";
import { addConfirmation, ingestBook, setVisibility } from "../src/catalog";
import {
  approveInterview,
  checkBriefs,
  guestPostsFor,
  inviteDueInterviews,
  newsBriefHandler,
  pitchGuestPost,
  postReviewHandler,
  saveGuestDraft,
  saveInterviewAnswers,
  submitGuestPost,
} from "../src/content";
import { createDb, type Db } from "../src/db";
import type { EditorialKind } from "../src/db/schema";
import {
  authorMembers,
  authorNotices,
  authors,
  bookAuthors,
  inboxItems,
  interviewResponses,
  newsTips,
  posts,
  users,
} from "../src/db/schema";
import {
  boundedDistance,
  buildEditorialQueue,
  buildWorkItems,
  claimItems,
  enqueue,
  pushProposals,
  startRun,
  typoOnly,
} from "../src/editorial";
import { defaultSettings, type Settings } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
let settings: Settings;
const env = { origin: "https://readlitrpg.com", mediaOrigin: "https://media.readlitrpg.com" };
const now = new Date();
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
  settings = defaultSettings();
});

async function book(title: string, extra: Partial<Parameters<typeof ingestBook>[1]> = {}) {
  const { bookId } = await ingestBook(
    db,
    { title, authors: [{ name: "Ann Writer" }], primaryGenre: "litrpg", ...extra },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  return bookId;
}

async function claim(kind: EditorialKind) {
  const run = await startRun(db, { kind: "daily", label: "test" });
  const items = await claimItems(db, { runId: run.id, kinds: [kind], limit: 10, claimHours: 3 });
  const { work } = await buildWorkItems(db, items);
  return { run, work };
}

async function verifiedAuthor(email: string, trust: "T1" | "T2") {
  const userId = `u-${email.split("@")[0]}`;
  await db.insert(users).values({ id: userId, email, state: "active", emailVerified: true });
  const r = await createProfile(db, userId, { name: `Author ${email.split("@")[0]}` });
  if (r.status !== "created") throw new Error("profile");
  await db.update(authors).set({ trustLevel: trust }).where(eq(authors.id, r.authorId));
  return { userId, authorId: r.authorId };
}

describe("typo-only fixes", () => {
  it("allows a few letters, never reworded text or changed numbers", () => {
    expect(boundedDistance("kitten", "sitting", 5)).toBe(3);
    expect(boundedDistance("abc", "abcdefgh", 2)).toBe(3);
    expect(typoOnly("I wrote teh first book in 2019.", "I wrote the first book in 2019.")).toBe(true);
    expect(typoOnly("I wrote the first book in 2019.", "I wrote the first book in 2020.")).toBe(false);
    expect(typoOnly("It started as a joke with friends.", "It began as a bit of fun among friends.")).toBe(
      false,
    );
  });
});

describe("the news scan", () => {
  it("queues one scan a day and turns cited briefs into checked news posts", async () => {
    const hunter = await book("The Primal Hunter", { authors: [{ name: "Zogarth" }] });
    expect(await buildEditorialQueue(db, settings, now)).toMatchObject({ newsScan: 1 });
    expect(await buildEditorialQueue(db, settings, now)).toMatchObject({ newsScan: 0 });
    const { run, work } = await claim("news_scan");
    expect(work[0]?.input).toMatchObject({ date: day(0), rules: { max_briefs: 8 } });

    const [outcome] = await pushProposals({ db, runId: run.id, settings, renderEnv: env }, [
      {
        kind: "news_scan",
        item_id: work[0]?.item_id,
        briefs: [
          {
            headline: "The Primal Hunter gets a new audiobook",
            body: `The publisher announced the audiobook of [[book:${hunter}]], out next month.`,
            sources: [{ url: "https://publisher.example/news" }],
            subjects: [{ kind: "book", id: hunter }],
            confidence: "high",
          },
          {
            headline: "A LitRPG convention announces its dates",
            body: "The organizers published the dates for next year's event.",
            sources: [{ url: "https://con.example/dates" }],
            subjects: [],
            confidence: "medium",
          },
        ],
      },
    ]);
    expect(outcome?.status).toBe("accepted");
    expect((await db.select().from(newsTips)).map((t) => t.status)).toEqual(["queued", "queued"]);

    const pages: Record<string, string> = {
      "https://publisher.example/news":
        "<html><body><h1>The Primal Hunter audiobook</h1><p>by Zogarth</p></body></html>",
    };
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return new Response(pages[url] ?? "not found", { status: pages[url] ? 200 : 404 });
    }) as typeof fetch;
    expect(await checkBriefs(db, env, settings, { fetch: fakeFetch, now })).toBe(2);
    const [news] = await db.select().from(posts).where(eq(posts.type, "news"));
    expect(news).toMatchObject({ status: "published", title: "The Primal Hunter gets a new audiobook" });
    expect(news?.sources).toEqual([{ url: "https://publisher.example/news" }]);
    expect(news?.bodyMd).toContain(`[[book:${hunter}]]`);

    // No catalog subject: the owner decides.
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "news_brief"));
    expect(item?.title).toContain("convention");
    await newsBriefHandler.approve?.(db, item as NonNullable<typeof item>, {
      decidedBy: "owner",
      now,
      settings,
      renderEnv: env,
    });
    expect(await db.select({ id: posts.id }).from(posts).where(eq(posts.type, "news"))).toHaveLength(2);
  });
});

describe("guide drafts", () => {
  it("accepts a guide built only from the tag's books and refuses invented titles", async () => {
    const ids: string[] = [];
    for (const t of ["Core One", "Core Two", "Core Three", "Core Four", "Core Five", "Core Six"])
      ids.push(await book(t, { tags: [{ slug: "dungeon-core", confidence: 0.95 }] }));
    await book("Dungeon Crawler Carl", { authors: [{ name: "Matt Dinniman" }] });
    await enqueue(db, [
      { kind: "post_draft", subjectType: "guide_tag", subjectId: "dungeon-core", priority: 30 },
    ]);
    const { run, work } = await claim("post_draft");
    const input = work[0]?.input as { topic_key: string; books: { id: string }[] };
    expect(input.books).toHaveLength(6);
    const proposal = {
      kind: "post_draft",
      item_id: work[0]?.item_id,
      topic_key: input.topic_key,
      title: "Dungeon Core: where to start",
      dek: "Run a dungeon, grow a dungeon.",
      sections: [
        { heading: "Start here", intro_md: `Begin with [[book:${ids[0]}]].`, book_ids: ids.slice(0, 3) },
        { heading: "Then", intro_md: "More base-building.", book_ids: ids.slice(3) },
      ],
      outro_md: "Follow a series to hear about new books.",
    };
    const [bad] = await pushProposals({ db, runId: run.id, settings }, [
      { ...proposal, dek: "Better than Dungeon Crawler Carl." },
    ]);
    expect(bad?.status).toBe("rejected");
    expect(bad?.reasons.join(" ")).toContain('names "Dungeon Crawler Carl"');
    const [good] = await pushProposals({ db, runId: run.id, settings }, [proposal]);
    expect(good?.status).toBe("accepted");
    const [draft] = await db.select().from(posts).where(eq(posts.type, "ai_editorial"));
    expect(draft).toMatchObject({
      status: "in_review",
      aiInvolvement: "generated",
      genKey: "guide:tag:dungeon-core",
    });
    const [review] = await db.select().from(inboxItems).where(eq(inboxItems.type, "post_review"));
    expect(review?.defaultAction).toBe("approve");
    await postReviewHandler.approve?.(db, review as NonNullable<typeof review>, {
      decidedBy: "x",
      now,
      settings,
    });
    const [scheduled] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, draft?.id ?? ""));
    expect(scheduled?.status).toBe("scheduled");
  });
});

describe("guest posts", () => {
  it("pitch, pre-review, draft, submit and a slot, with the author told at each step", async () => {
    const a = await verifiedAuthor("guest@example.com", "T2");
    const postId = await pitchGuestPost(
      db,
      {
        ...a,
        trust: "T2",
        title: "Designing skill trees",
        pitch:
          "How I design skill trees readers can follow without a spreadsheet, with examples from other authors.",
      },
      env,
      settings,
    );
    const pitch = await claim("guest_review");
    expect(pitch.work[0]?.input).toMatchObject({ stage: "pitch", title: "Designing skill trees" });
    await pushProposals({ db, runId: pitch.run.id, settings }, [
      {
        kind: "guest_review",
        item_id: pitch.work[0]?.item_id,
        stage: "pitch",
        verdict: "approve",
        issues: [],
        self_promo_mentions: 0,
        summary: "On topic: craft.",
      },
    ]);
    expect((await guestPostsFor(db, [a.authorId]))[0]).toMatchObject({
      pitchStatus: "accepted",
      status: "drafting",
    });

    const body = Array.from(
      { length: 110 },
      (_, i) => `Paragraph ${i} about skill trees and pacing choices.`,
    ).join("\n\n");
    await saveGuestDraft(
      db,
      postId,
      a.userId,
      { title: "Designing skill trees", dek: "How.", bodyMd: body },
      env,
    );
    await expect(
      submitGuestPost(db, postId, { guidelines: true, license: false }, settings),
    ).rejects.toThrow();
    await submitGuestPost(db, postId, { guidelines: true, license: true }, settings, now);
    const post = await claim("guest_review");
    expect(post.work[0]?.input).toMatchObject({ stage: "post" });
    await pushProposals({ db, runId: post.run.id, settings }, [
      {
        kind: "guest_review",
        item_id: post.work[0]?.item_id,
        stage: "post",
        verdict: "approve",
        issues: [],
        self_promo_mentions: 1,
        summary: "Clean.",
      },
    ]);
    const [review] = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.type, "post_review"), eq(inboxItems.status, "open")));
    expect(review).toMatchObject({ aiRecommendation: "approve", defaultAction: "approve" });
    await postReviewHandler.approve?.(db, review as NonNullable<typeof review>, {
      decidedBy: "x",
      now,
      settings,
    });
    const [scheduled] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(scheduled?.status).toBe("scheduled");
    expect((await db.select({ kind: authorNotices.kind }).from(authorNotices)).map((n) => n.kind)).toEqual([
      "pitch_accepted",
      "guest_scheduled",
    ]);
  });
});

describe("interviews", () => {
  it("invites before a release, formats the answers with typo fixes only, and publishes once approved", async () => {
    const a = await verifiedAuthor("interview@example.com", "T1");
    const bookId = await book("Tower of Ledgers", { releases: [{ kind: "ebook", date: day(25) }] });
    // Credit the book to the author's profile.

    await db.delete(bookAuthors).where(eq(bookAuthors.bookId, bookId));
    await db.insert(bookAuthors).values({ bookId, authorId: a.authorId, position: 0 });
    expect(await db.select().from(authorMembers)).toHaveLength(1);

    expect(await inviteDueInterviews(db, now)).toBe(1);
    expect(await inviteDueInterviews(db, now)).toBe(0);
    const [row] = await db.select().from(interviewResponses);
    const answers = {
      hook: "A clerk audits the dungeon.",
      system: "The system is a ledgr of debts.",
      progression: "Balancing the books in chapter 20.",
      origin: "My day job.",
      mc: "Spite and spreadsheets.",
      recs: "Three books by others.",
    };
    await expect(
      saveInterviewAnswers(db, row?.id ?? "", a.userId, { hook: "one" }, { submit: true, priority: 65 }),
    ).rejects.toThrow("answer at least 6");
    await saveInterviewAnswers(db, row?.id ?? "", a.userId, answers, { submit: true, priority: 65 });
    const { run, work } = await claim("interview_format");
    expect((work[0]?.input as { questions?: unknown[] } | undefined)?.questions).toHaveLength(6);
    const format = {
      kind: "interview_format",
      item_id: work[0]?.item_id,
      headline: "An interview about ledgers",
      intro: "The new book is out soon. Here the author talks systems.",
      order: ["hook", "system", "progression", "recs"],
    };
    const [reworded] = await pushProposals({ db, runId: run.id, settings }, [
      { ...format, fixes: { system: "The magic system is built from debts owed to the dungeon." } },
    ]);
    expect(reworded?.reasons).toContain("fixes.system: more than a typo fix");
    const [ok] = await pushProposals({ db, runId: run.id, settings }, [
      { ...format, fixes: { system: "The system is a ledger of debts." } },
    ]);
    expect(ok?.status).toBe("accepted");
    const postId = await approveInterview(db, row?.id ?? "", a.userId, env, settings, now);
    const [post] = await db.select().from(posts).where(eq(posts.id, postId));
    expect(post?.bodyMd).toContain("The system is a ledger of debts.");
    expect(post?.bodyMd).not.toContain("My day job.");
    expect(post).toMatchObject({ type: "interview", status: "in_review", bylineAuthorId: a.authorId });
    expect((await db.select({ kind: authorNotices.kind }).from(authorNotices)).map((n) => n.kind)).toEqual([
      "interview_invite",
      "interview_ready",
    ]);
  });
});
