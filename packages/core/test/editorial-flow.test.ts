import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type BookInput, type IngestContext, ingestBook, setVisibility } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  bookFieldSources,
  bookScores,
  books,
  bookTags,
  catalogConfirmations,
  editorialProposals,
  editorialQueue,
  editorialRuns,
  inboxItems,
  tags,
} from "../src/db/schema";
import {
  applyHeldProposal,
  buildEditorialQueue,
  buildWorkItems,
  checkPendingCitations,
  claimItems,
  discardHeldProposal,
  editorialWatchdog,
  enqueue,
  finishRun,
  htmlToText,
  pageMentions,
  pushProposals,
  startRun,
} from "../src/editorial";
import { openInboxItem, runInboxDefaults } from "../src/inbox";
import { defaultSettings, type Settings } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";
import { classification } from "./helpers/proposals";

let db: Db;
let settings: Settings;
beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
  settings = defaultSettings();
});

const seed: IngestContext = { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 };

const hunter: BookInput = {
  title: "The Primal Hunter",
  authors: [{ name: "Zogarth" }],
  series: { name: "The Primal Hunter", position: 1 },
  primaryGenre: "litrpg",
  tags: [{ slug: "system-apocalypse" }, { slug: "cultivation" }],
  confidence: 0.85,
};

async function bookId(input: BookInput = hunter) {
  return (await ingestBook(db, input, seed)).bookId;
}

async function claimAll(runId: string, kinds: ("classify" | "dedupe" | "research")[] = ["classify"]) {
  return claimItems(db, { runId, kinds, limit: 50, claimHours: 3 });
}

const tagScores = async (id: string) =>
  Object.fromEntries(
    (
      await db
        .select({ slug: tags.slug, score: bookTags.score, ai: bookTags.aiConfidence })
        .from(bookTags)
        .innerJoin(tags, eq(tags.id, bookTags.tagId))
        .where(eq(bookTags.bookId, id))
    ).map((r) => [r.slug, r]),
  );

describe("the editorial queue", () => {
  it("queues each unclassified book once, and claims in priority order without double-claiming", async () => {
    const a = await bookId();
    const b = await bookId({
      ...hunter,
      title: "Delve",
      authors: [{ name: "SenescentSoul" }],
      series: undefined,
    });
    expect(await buildEditorialQueue(db, settings)).toMatchObject({ classify: 2 });
    expect(await buildEditorialQueue(db, settings)).toMatchObject({ classify: 0 });
    await enqueue(db, [
      { kind: "moderate", subjectType: "text", subjectId: "t1", priority: 80, payload: { text: "hi" } },
    ]);

    const run1 = await startRun(db, { kind: "manual" });
    const run2 = await startRun(db, { kind: "manual" });
    const first = await claimItems(db, {
      runId: run1.id,
      kinds: ["classify", "moderate"],
      limit: 2,
      claimHours: 3,
    });
    expect(first.map((i) => i.kind)).toEqual(["moderate", "classify"]);
    const second = await claimItems(db, {
      runId: run2.id,
      kinds: ["classify", "moderate"],
      limit: 5,
      claimHours: 3,
    });
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((i) => i.subjectId))).toEqual(new Set(["t1", a, b]));
  });

  it("builds payloads with the book, its series siblings and current tags", async () => {
    const id = await bookId();
    await bookId({
      ...hunter,
      title: "The Primal Hunter 2",
      series: { name: "The Primal Hunter", position: 2 },
    });
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const items = await claimAll(run.id);
    const { work } = await buildWorkItems(db, items);
    const mine = work.find((w) => (w.input as { book: { id: string } }).book.id === id);
    if (!mine) throw new Error("no work item for the book");
    const book = (mine.input as { book: Record<string, unknown> }).book;
    expect(book).toMatchObject({
      title: "The Primal Hunter",
      authors: ["Zogarth"],
      series: { name: "The Primal Hunter", position: 1 },
      series_books: [{ title: "The Primal Hunter 2", position: 2 }],
      confirmed: false,
    });
    expect((book.current as { tags: { slug: string }[] }).tags.map((t) => t.slug).sort()).toEqual([
      "cultivation",
      "system-apocalypse",
    ]);
  });
});

describe("pushing proposals", () => {
  it("applies a classification through provenance, replacing the AI's earlier tags", async () => {
    const id = await bookId();
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id);
    if (!item) throw new Error("nothing claimed");
    const [outcome] = await pushProposals({ db, runId: run.id, settings }, [classification(id, item.id)]);
    expect(outcome).toMatchObject({ status: "accepted", item_id: item.id });

    const [book] = await db.select().from(books).where(eq(books.id, id));
    expect(book).toMatchObject({
      crunchLevel: 2,
      romanceLevel: 0,
      harem: "none",
      contentFlags: ["graphic-violence"],
      hookAi: "Survive the tutorial, then outgrow it.",
    });
    expect(book?.classifiedAt).toBeTruthy();
    // The seed said "cultivation"; the classification didn't list it, so the AI's evidence is gone.
    const scores = await tagScores(id);
    expect(scores["system-apocalypse"]?.score).toBeCloseTo(0.85);
    expect(scores.humorous?.score).toBeCloseTo(0.45);
    expect(scores.cultivation?.ai).toBeNull();
    expect(scores.cultivation?.score).toBe(0);

    const dials = await db.select().from(bookScores).where(eq(bookScores.bookId, id));
    const byKey = Object.fromEntries(dials.map((d) => [d.key, d]));
    expect(byKey.pacing).toMatchObject({ kind: "dial", value: 7, public: true });
    expect(byKey.lore).toMatchObject({ value: null, public: false });
    // Descriptive stats show as estimates; judgment stats wait for readers (§6.7).
    expect(byKey.number_go_up).toMatchObject({ kind: "stat", value: 9, public: true });
    expect(byKey.competent_mc).toMatchObject({ value: 7, public: false });

    const sources = await db
      .select()
      .from(bookFieldSources)
      .where(and(eq(bookFieldSources.bookId, id), eq(bookFieldSources.field, "summaryAi")));
    expect(sources[0]).toMatchObject({ source: "ai", sourceRef: `run:${run.id}` });
    const [queueRow] = await db.select().from(editorialQueue).where(eq(editorialQueue.id, item.id));
    expect(queueRow).toMatchObject({ status: "done", openKey: null });
    const [runRow] = await db.select().from(editorialRuns).where(eq(editorialRuns.id, run.id));
    expect(runRow).toMatchObject({ proposalsAccepted: 1, proposalsRejected: 0 });
  });

  it("rejects invalid proposals but lets the run fix and push again", async () => {
    const id = await bookId();
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id);
    if (!item) throw new Error("nothing claimed");
    const bad = classification(id, item.id, { primary_genre: "romance-novel" });
    const [first] = await pushProposals({ db, runId: run.id, settings }, [bad]);
    expect(first?.status).toBe("rejected");
    expect(first?.reasons.join()).toMatch(/genre/);
    const [second] = await pushProposals({ db, runId: run.id, settings }, [classification(id, item.id)]);
    expect(second?.status).toBe("accepted");
    const [third] = await pushProposals({ db, runId: run.id, settings }, [classification(id, item.id)]);
    expect(third).toMatchObject({ status: "rejected", reasons: [expect.stringMatching(/not claimed/)] });
  });

  it("refuses answers for items another run holds, or for the wrong book", async () => {
    const id = await bookId();
    const other = await bookId({
      ...hunter,
      title: "Defiance of the Fall",
      authors: [{ name: "TheFirstDefier" }],
      series: undefined,
    });
    await buildEditorialQueue(db, settings);
    const run1 = await startRun(db, { kind: "manual" });
    const run2 = await startRun(db, { kind: "manual" });
    const [item] = await claimItems(db, { runId: run1.id, kinds: ["classify"], limit: 1, claimHours: 3 });
    if (!item) throw new Error("nothing claimed");
    const [stolen] = await pushProposals({ db, runId: run2.id, settings }, [
      classification(item.subjectId, item.id),
    ]);
    expect(stolen?.status).toBe("rejected");
    const wrong = item.subjectId === id ? other : id;
    const [mismatch] = await pushProposals({ db, runId: run1.id, settings }, [
      classification(wrong, item.id),
    ]);
    expect(mismatch?.reasons.join()).toMatch(/book_id must be/);
  });

  it("holds a classification with instructions in the text, and the owner can apply it", async () => {
    const id = await bookId();
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id);
    if (!item) throw new Error("nothing claimed");
    const [out] = await pushProposals({ db, runId: run.id, settings }, [
      classification(id, item.id, { anomalies: ["instructions_in_text"] }),
    ]);
    expect(out?.status).toBe("held");
    const [held] = await db
      .select()
      .from(editorialProposals)
      .where(eq(editorialProposals.id, out?.proposal_id ?? ""));
    const [inbox] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, held?.inboxItemId ?? ""));
    expect(inbox).toMatchObject({ type: "classification_review", priority: 90, status: "open" });
    expect((await db.select().from(books).where(eq(books.id, id)))[0]?.classifiedAt).toBeNull();

    await applyHeldProposal(db, out?.proposal_id ?? "", "owner", settings);
    expect((await db.select().from(books).where(eq(books.id, id)))[0]?.classifiedAt).toBeTruthy();
    const [closed] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, inbox?.id ?? ""));
    expect(closed?.status).toBe("approved");
    await expect(discardHeldProposal(db, out?.proposal_id ?? "", "owner")).rejects.toThrow(/isn't waiting/);
  });

  it("holds changes to public books while auto-publish is off", async () => {
    const id = await bookId();
    await db.update(books).set({ confirmedAt: "2026-01-01T00:00:00.000Z" }).where(eq(books.id, id));
    expect((await setVisibility(db, id, "published")).ok).toBe(true);
    settings["flags.auto_publish"] = false;
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id);
    if (!item) throw new Error("nothing claimed");
    const [out] = await pushProposals({ db, runId: run.id, settings }, [classification(id, item.id)]);
    expect(out?.status).toBe("held");
    await discardHeldProposal(db, out?.proposal_id ?? "", "owner");
    const [row] = await db
      .select()
      .from(editorialProposals)
      .where(eq(editorialProposals.id, out?.proposal_id ?? ""));
    expect(row?.status).toBe("discarded");
  });

  it("opens a scope check when a run marks a book out of scope", async () => {
    const id = await bookId();
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id);
    if (!item) throw new Error("nothing claimed");
    await pushProposals({ db, runId: run.id, settings }, [
      classification(id, item.id, { in_scope: "no", anomalies: ["not_in_scope"] }),
    ]);
    const [check] = await db.select().from(inboxItems).where(eq(inboxItems.type, "scope_check"));
    expect(check).toMatchObject({ subjectId: id, defaultAction: "approve" });
    expect((await db.select().from(books).where(eq(books.id, id)))[0]?.inScope).toBe("no");
    // Its default runs once the week is up: the verdict is already applied, so it just closes.
    expect(await runInboxDefaults(db, new Date(Date.now() + 8 * 86_400_000))).toBe(1);
  });

  it("trips the circuit breaker and holds the rest of the run for the owner", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        await bookId({
          title: `Book ${i} of Many`,
          authors: [{ name: `Author ${i}` }],
          primaryGenre: "litrpg",
        }),
      );
    }
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const items = await claimAll(run.id);
    const bySubject = new Map(items.map((i) => [i.subjectId, i.id]));
    const proposals = ids.map((id, n) =>
      n < 3
        ? classification(id, bySubject.get(id) ?? "", { primary_genre: "nope" })
        : classification(id, bySubject.get(id) ?? ""),
    );
    const outcomes = await pushProposals({ db, runId: run.id, settings }, proposals);
    // 3 rejected of the first 10 (30%) trips it; the last two are held.
    expect(outcomes.map((o) => o.status)).toEqual([
      ...Array(3).fill("rejected"),
      ...Array(7).fill("accepted"),
      "held",
      "held",
    ]);
    const held = await db.select().from(inboxItems).where(eq(inboxItems.type, "editorial_run_held"));
    expect(held).toHaveLength(1);
    const [runRow] = await db.select().from(editorialRuns).where(eq(editorialRuns.id, run.id));
    expect(runRow?.circuitOpen).toBe(true);
  });
});

describe("dedupe pre-judging", () => {
  it("records the verdict on the inbox item and closes confident 'different work' calls", async () => {
    const a = await bookId({ title: "Founding", authors: [{ name: "Aleron Kong" }], primaryGenre: "litrpg" });
    const b = await bookId({
      title: "The Land: Founding",
      authors: [{ name: "Aleron Kong" }],
      primaryGenre: "litrpg",
    });
    expect(a).not.toBe(b);
    const [dup] = await db.select().from(inboxItems).where(eq(inboxItems.type, "possible_duplicate"));
    expect(dup).toBeTruthy();
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id, ["dedupe"]);
    if (!item) throw new Error("nothing claimed");
    const { work } = await buildWorkItems(db, [item]);
    expect(work[0]?.input).toMatchObject({
      a: { title: expect.any(String) },
      b: { title: expect.any(String) },
    });

    const [out] = await pushProposals({ db, runId: run.id, settings }, [
      {
        kind: "dedupe",
        item_id: item.id,
        verdict: "same_work",
        confidence: "high",
        keep_id: a,
        reasons: "Same book.",
      },
    ]);
    expect(out?.status).toBe("accepted");
    const [after] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, dup?.id ?? ""));
    expect(after).toMatchObject({ status: "open", aiRecommendation: "approve" });
    expect(after?.aiSummary).toMatch(/same work/);
    // It isn't queued again once a run has looked at it.
    expect((await buildEditorialQueue(db, settings)).dedupe).toBe(0);
  });

  it("closes the question on a confident different-work verdict", async () => {
    await bookId({ title: "Founding", authors: [{ name: "Aleron Kong" }], primaryGenre: "litrpg" });
    await bookId({ title: "The Land: Founding", authors: [{ name: "Aleron Kong" }], primaryGenre: "litrpg" });
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id, ["dedupe"]);
    await pushProposals({ db, runId: run.id, settings }, [
      {
        kind: "dedupe",
        item_id: item?.id,
        verdict: "different_work",
        confidence: "high",
        reasons: "Different series.",
      },
    ]);
    const [after] = await db.select().from(inboxItems).where(eq(inboxItems.type, "possible_duplicate"));
    expect(after).toMatchObject({ status: "auto_rejected", reasonCode: "ai_different_work" });
  });
});

describe("research and citation checks", () => {
  async function researchItem() {
    const id = await bookId({
      title: "Unsouled",
      authors: [{ name: "Will Wight" }],
      series: { name: "Cradle", position: 1 },
    });
    await db.update(books).set({ enrichStatus: "no_match" }).where(eq(books.id, id));
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimAll(run.id, ["research"]);
    if (!item) throw new Error("nothing claimed");
    return { id, run, item };
  }

  const page = (body: string) =>
    (async () =>
      new Response(`<html><body>${body}</body></html>`, { status: 200 })) as unknown as typeof fetch;

  it("confirms a seed only after the cited page mentions the title and author", async () => {
    const { id, run, item } = await researchItem();
    const [out] = await pushProposals({ db, runId: run.id, settings }, [
      {
        kind: "research",
        item_id: item.id,
        book_id: id,
        verdict: "confirmed",
        confidence: "high",
        sources: [{ url: "https://wightbooks.com/cradle", quote: "Unsouled, book one of Cradle" }],
        facts: { series_position: 1, first_published: { date: "2016-01-01", precision: "year" } },
      },
    ]);
    expect(out?.status).toBe("pending_check");
    expect((await db.select().from(books).where(eq(books.id, id)))[0]?.confirmedAt).toBeNull();

    await checkPendingCitations(db, {
      fetch: page(
        "<h1>Cradle</h1><p>Unsouled &mdash; the first book by Will&nbsp;Wight.</p><script>x</script>",
      ),
    });
    const [book] = await db.select().from(books).where(eq(books.id, id));
    expect(book?.confirmedAt).toBeTruthy();
    expect(book?.firstPublished).toBe("2016-01-01");
    const [conf] = await db.select().from(catalogConfirmations).where(eq(catalogConfirmations.subjectId, id));
    expect(conf).toMatchObject({ source: "research", sourceRef: "https://wightbooks.com/cradle" });
    const [row] = await db
      .select()
      .from(editorialProposals)
      .where(eq(editorialProposals.id, out?.proposal_id ?? ""));
    expect(row?.status).toBe("accepted");
  });

  it("marks citations that don't mention the book as unverified, and retries network failures", async () => {
    const { id, run, item } = await researchItem();
    const [out] = await pushProposals({ db, runId: run.id, settings }, [
      {
        kind: "research",
        item_id: item.id,
        book_id: id,
        verdict: "confirmed",
        confidence: "medium",
        sources: [{ url: "https://example.org/list" }],
      },
    ]);
    const failing = (async () => {
      throw new TypeError("connection reset");
    }) as unknown as typeof fetch;
    await checkPendingCitations(db, { fetch: failing });
    let [row] = await db
      .select()
      .from(editorialProposals)
      .where(eq(editorialProposals.id, out?.proposal_id ?? ""));
    expect(row?.status).toBe("pending_check");
    await checkPendingCitations(db, { fetch: page("<p>Some other book by Will Wight.</p>") });
    [row] = await db
      .select()
      .from(editorialProposals)
      .where(eq(editorialProposals.id, out?.proposal_id ?? ""));
    expect(row?.status).toBe("unverified");
    expect((await db.select().from(books).where(eq(books.id, id)))[0]?.confirmedAt).toBeNull();
  });

  it("sends 'not found' to the owner", async () => {
    const { id, run, item } = await researchItem();
    await pushProposals({ db, runId: run.id, settings }, [
      {
        kind: "research",
        item_id: item.id,
        book_id: id,
        verdict: "not_found",
        confidence: "medium",
        sources: [],
      },
    ]);
    const [check] = await db.select().from(inboxItems).where(eq(inboxItems.type, "seed_check"));
    expect(check).toMatchObject({ subjectId: id, aiRecommendation: "reject" });
  });

  it("matches titles and names regardless of punctuation and markup", () => {
    const text = htmlToText("<li><a href='/x'>Mother of Learning (Arc 1)</a> by Domagoj&nbsp;Kurmaić</li>");
    expect(pageMentions(text, "Mother of Learning: Arc 1", ["Domagoj Kurmaić"])).toBe(true);
    expect(pageMentions(text, "Mother of Learning: Arc 2", ["Domagoj Kurmaić"])).toBe(false);
    expect(pageMentions(text, "Mother of Learning: Arc 1", ["Someone Else"])).toBe(false);
  });
});

describe("runs and the watchdog", () => {
  it("returns unanswered items to the queue when a run finishes", async () => {
    await bookId();
    await buildEditorialQueue(db, settings);
    const run = await startRun(db, { kind: "manual" });
    expect(await claimAll(run.id)).toHaveLength(1);
    await finishRun(db, run.id, { status: "succeeded" });
    const [row] = await db.select().from(editorialQueue);
    expect(row).toMatchObject({ status: "queued", claimedByRun: null });
  });

  it("releases expired claims, expires items after three tries, abandons dead runs, and alerts", async () => {
    await bookId();
    await buildEditorialQueue(db, settings);
    const start = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const run = await startRun(db, { kind: "manual" });
      await claimItems(db, {
        runId: run.id,
        kinds: ["classify"],
        limit: 5,
        claimHours: 1,
        now: new Date(start),
      });
      const result = await editorialWatchdog(db, 36, new Date(start + 2 * 3_600_000));
      if (attempt < 3) expect(result).toMatchObject({ released: 1, expired: 0 });
      else expect(result).toMatchObject({ released: 0, expired: 1 });
    }
    const [row] = await db.select().from(editorialQueue);
    expect(row).toMatchObject({ status: "expired", attempts: 3 });

    const later = new Date(start + 13 * 3_600_000);
    expect((await editorialWatchdog(db, 36, later)).abandoned).toBe(3);

    // Work waiting longer than the stale window with no successful run: one alert.
    await bookId({ ...hunter, title: "Another Book", authors: [{ name: "Someone" }], series: undefined });
    await buildEditorialQueue(db, settings, new Date(start));
    const muchLater = new Date(start + 40 * 3_600_000);
    await db.update(editorialQueue).set({ createdAt: new Date(start).toISOString() });
    expect((await editorialWatchdog(db, 36, muchLater)).alerted).toBe(true);
    expect((await editorialWatchdog(db, 36, muchLater)).alerted).toBe(false);
  });

  it("doesn't alert before any run exists when nothing has waited long", async () => {
    await bookId();
    await buildEditorialQueue(db, settings);
    expect((await editorialWatchdog(db, 36)).alerted).toBe(false);
  });
});

describe("the inbox", () => {
  it("runs only the defaults whose effect is already applied", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await openInboxItem(db, {
      type: "tag_check",
      title: "t",
      defaultAction: "approve",
      defaultActionAt: past,
    });
    await openInboxItem(db, {
      type: "listing_unverified",
      title: "l",
      defaultAction: "approve",
      defaultActionAt: past,
    });
    expect(await runInboxDefaults(db)).toBe(1);
    const rows = await db.select().from(inboxItems);
    expect(Object.fromEntries(rows.map((r) => [r.type, r.status]))).toEqual({
      tag_check: "auto_approved",
      listing_unverified: "open",
    });
  });
});
