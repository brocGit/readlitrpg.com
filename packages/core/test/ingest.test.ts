import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addConfirmation,
  type BookInput,
  type IngestContext,
  ingestBook,
  mergeBooks,
  publicationGate,
  setVisibility,
  unmergeBooks,
} from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  authors,
  bookAuthors,
  bookFieldSources,
  bookLinks,
  books,
  bookTags,
  editions,
  inboxItems,
  series,
  tags,
} from "../src/db/schema";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

const seed: IngestContext = {
  source: "ai",
  origin: "ai_seed",
  sourceRef: "seed:test",
  fuzzyMin: 0.6,
  crowdMinVotes: 8,
};
const admin: IngestContext = {
  source: "admin",
  origin: "admin",
  actorId: "owner",
  confirmation: { source: "owner_check" },
  fuzzyMin: 0.6,
  crowdMinVotes: 8,
};

const hunter1: BookInput = {
  title: "The Primal Hunter",
  authors: [{ name: "Zogarth" }],
  series: { name: "The Primal Hunter", position: 1, status: "ongoing" },
  primaryGenre: "litrpg",
  tags: [{ slug: "system-apocalypse" }, { slug: "xianxia" }, { slug: "no-such-tag" }],
  crunchLevel: 2,
  harem: "none",
  confidence: 0.8,
};

const book = async (id: string) => (await db.select().from(books).where(eq(books.id, id)))[0];

describe("ingest", () => {
  it("creates a draft seed with authors, series, tags and provenance", async () => {
    const r = await ingestBook(db, hunter1, seed);
    expect(r).toMatchObject({ created: true, matchedBy: "created" });
    expect(r.warnings).toContain('unknown tag "no-such-tag"');
    const b = await book(r.bookId);
    expect(b).toMatchObject({
      title: "The Primal Hunter",
      titleKey: "primal hunter",
      slug: "the-primal-hunter",
      visibility: "draft",
      origin: "ai_seed",
      seriesPosition: 1,
      primaryGenre: "litrpg",
      crunchLevel: 2,
      harem: "none",
      confirmedAt: null,
    });
    const [s] = await db.select().from(series);
    expect(s).toMatchObject({ name: "The Primal Hunter", status: "ongoing" });
    const tagRows = await db
      .select({ slug: tags.slug, score: bookTags.score })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, r.bookId));
    // "xianxia" is a synonym of cultivation.
    expect(tagRows.map((t) => t.slug).sort()).toEqual(["cultivation", "system-apocalypse"]);
    expect(tagRows[0]?.score).toBe(0.8);
    expect(publicationGate(b as NonNullable<typeof b>)).toEqual({
      ok: false,
      reason: "needs an independent confirmation",
    });
  });

  it("is idempotent: the same input writes nothing new", async () => {
    const a = await ingestBook(db, hunter1, seed);
    const sourcesBefore = (await db.select().from(bookFieldSources)).length;
    const b = await ingestBook(db, hunter1, seed);
    expect(b).toMatchObject({ bookId: a.bookId, created: false, matchedBy: "title" });
    expect((await db.select().from(bookFieldSources)).length).toBe(sourcesBefore);
    expect(await db.select().from(books)).toHaveLength(1);
    expect(await db.select().from(authors)).toHaveLength(1);
    expect(await db.select().from(series)).toHaveLength(1);
  });

  it("the owner's quick-add matches the seed, overrides it and confirms it", async () => {
    const seeded = await ingestBook(db, hunter1, seed);
    const r = await ingestBook(
      db,
      {
        title: "The Primal Hunter: A LitRPG Adventure (The Primal Hunter Book 1)",
        authors: [{ name: "Zogarth" }],
        crunchLevel: 3,
        links: [
          "https://www.amazon.com/dp/B09JZ4XYZ1/ref=sr_1_1?tag=x-20",
          "https://www.royalroad.com/fiction/36049/the-primal-hunter",
        ],
      },
      admin,
    );
    expect(r).toMatchObject({ bookId: seeded.bookId, matchedBy: "title" });
    const b = await book(r.bookId);
    expect(b?.crunchLevel).toBe(3); // admin wins
    expect(b?.title).toBe("The Primal Hunter: A LitRPG Adventure (The Primal Hunter Book 1)");
    expect(b?.titleKey).toBe("primal hunter");
    expect(b?.confirmedAt).not.toBeNull();
    const links = await db.select().from(bookLinks).where(eq(bookLinks.bookId, r.bookId));
    expect(links.map((l) => l.kind).sort()).toEqual(["amazon", "royalroad"]);
    // The Amazon link created an ebook edition, so the next import can match on ASIN.
    const [ed] = await db.select().from(editions).where(eq(editions.bookId, r.bookId));
    expect(ed).toMatchObject({ format: "ebook", asin: "B09JZ4XYZ1" });
    expect(await setVisibility(db, r.bookId, "published")).toEqual({ ok: true });
    expect((await book(r.bookId))?.visibility).toBe("published");
  });

  it("matches on identifiers even when the title differs", async () => {
    const a = await ingestBook(db, { ...hunter1, editions: [{ format: "ebook", asin: "B09JZ4XYZ1" }] }, seed);
    const b = await ingestBook(
      db,
      {
        title: "Primal Hunter (Book One)",
        authors: [{ name: "Someone Else" }],
        editions: [{ format: "ebook", asin: "b09jz4xyz1" }],
      },
      seed,
    );
    expect(b).toMatchObject({ bookId: a.bookId, matchedBy: "asin" });
    expect(b.warnings).toContain("the author list differs from the existing record; not changed");
  });

  it("keeps sibling volumes apart", async () => {
    const one = await ingestBook(db, hunter1, seed);
    const two = await ingestBook(
      db,
      { ...hunter1, title: "The Primal Hunter 2", series: { name: "The Primal Hunter", position: 2 } },
      seed,
    );
    const three = await ingestBook(
      db,
      { ...hunter1, title: "The Primal Hunter 3", series: { name: "The Primal Hunter", position: 3 } },
      seed,
    );
    expect(new Set([one.bookId, two.bookId, three.bookId]).size).toBe(3);
    expect(three.duplicates).toEqual([]);
    expect(await db.select().from(inboxItems)).toHaveLength(0);
    // The same series slot from another source is the same book, even with a different title.
    const slot = await ingestBook(
      db,
      {
        title: "Primal Hunter Two",
        authors: [{ name: "Zogarth" }],
        series: { name: "The Primal Hunter", position: 2 },
      },
      seed,
    );
    expect(slot).toMatchObject({ bookId: two.bookId, matchedBy: "series_position" });
  });

  it("flags near-identical titles as possible duplicates instead of merging", async () => {
    const a = await ingestBook(db, { title: "Azarinth Healer", authors: [{ name: "Rhaegar" }] }, seed);
    const b = await ingestBook(db, { title: "Azarinth HeaIer", authors: [{ name: "Rhaegar" }] }, seed);
    expect(b.created).toBe(true);
    expect(b.duplicates.map((d) => d.bookId)).toEqual([a.bookId]);
    const [item] = await db.select().from(inboxItems);
    expect(item).toMatchObject({ type: "possible_duplicate", subjectId: b.bookId });
  });

  it("catches series-prefixed titles but not sequels or sibling subtitles", async () => {
    const land = await ingestBook(
      db,
      { title: "The Land: Founding", authors: [{ name: "Aleron Kong" }] },
      seed,
    );
    const bare = await ingestBook(db, { title: "Founding", authors: [{ name: "Aleron Kong" }] }, seed);
    expect(bare.duplicates.map((d) => d.bookId)).toEqual([land.bookId]);
    const forging = await ingestBook(
      db,
      { title: "The Land: Forging", authors: [{ name: "Aleron Kong" }] },
      seed,
    );
    expect(forging.duplicates).toEqual([]);
    await ingestBook(db, { title: "Delve", authors: [{ name: "SenescentSoul" }] }, seed);
    const delve2 = await ingestBook(db, { title: "Delve 2", authors: [{ name: "SenescentSoul" }] }, seed);
    expect(delve2).toMatchObject({ created: true, duplicates: [] });
  });

  it("keeps namesake series by different authors apart", async () => {
    await ingestBook(
      db,
      { title: "Ascension One", authors: [{ name: "Author A" }], series: { name: "Ascension" } },
      seed,
    );
    await ingestBook(
      db,
      { title: "Rise", authors: [{ name: "Author B" }], series: { name: "Ascension" } },
      seed,
    );
    const rows = await db.select().from(series);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(["ascension", "ascension-author-b"]);
  });

  it("uses the most cautious harem answer and never lets the AI set AI-use", async () => {
    const r = await ingestBook(db, { ...hunter1, harem: "harem", isAiGenerated: "ai_generated" }, seed);
    await ingestBook(
      db,
      { title: hunter1.title, authors: hunter1.authors, harem: "none", isAiGenerated: "human" },
      {
        ...seed,
        source: "author",
        origin: "author",
      },
    );
    const b = await book(r.bookId);
    expect(b?.harem).toBe("harem");
    expect(b?.isAiGenerated).toBe("human");
  });

  it("warns about bad identifiers and links, and flags shared identifiers", async () => {
    const a = await ingestBook(
      db,
      {
        title: "Book A",
        authors: [{ name: "X" }],
        editions: [{ format: "paperback", isbn: "978-0-306-40615-7" }],
      },
      seed,
    );
    const r = await ingestBook(
      db,
      {
        title: "Book B",
        authors: [{ name: "Y" }],
        editions: [
          { format: "ebook", isbn: "123" },
          { format: "hardcover", isbn: "9780306406157" },
        ],
        links: ["https://amzn.to/abc", "https://some-blog.example/review"],
      },
      seed,
    );
    // The ISBN already belongs to Book A, so B matched A.
    expect(r).toMatchObject({ bookId: a.bookId, matchedBy: "isbn" });
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "ignored invalid ISBN 123",
        "link skipped (shortened link: use the full address): https://amzn.to/abc",
        "link skipped (not a known store or platform): https://some-blog.example/review",
      ]),
    );
  });
});

describe("merge", () => {
  it("merges a duplicate into the survivor and can undo it", async () => {
    const a = await ingestBook(db, { ...hunter1, links: ["https://www.royalroad.com/fiction/36049"] }, seed);
    const b = await ingestBook(
      db,
      {
        title: "Primal Hunter, The",
        authors: [{ name: "Zogarth" }, { name: "Co Writer" }],
        editions: [{ format: "audiobook", audibleAsin: "B0B1234567", narrators: ["Travis Baldree"] }],
        pageCount: 700,
      },
      { ...admin, confirmation: undefined },
    );
    expect(b.created).toBe(true);
    await addConfirmation(db, {
      subjectType: "book",
      subjectId: b.bookId,
      source: "openlibrary",
      sourceRef: "OL1W",
    });

    const mergeId = await mergeBooks(db, a.bookId, b.bookId, "owner");
    const winner = await book(a.bookId);
    const loser = await book(b.bookId);
    expect(loser).toMatchObject({ redirectTo: a.bookId, visibility: "removed" });
    expect(winner?.pageCount).toBe(700); // the admin's page count moved with its provenance
    expect(winner?.confirmedAt).not.toBeNull();
    expect(
      (await db.select().from(editions).where(eq(editions.bookId, a.bookId))).map((e) => e.audibleAsin),
    ).toEqual(["B0B1234567"]);
    expect((await db.select().from(bookAuthors).where(eq(bookAuthors.bookId, a.bookId))).length).toBe(2);

    // Later ingests of the merged book land on the survivor.
    const again = await ingestBook(
      db,
      {
        title: "x",
        authors: [{ name: "Zogarth" }],
        editions: [{ format: "audiobook", audibleAsin: "B0B1234567" }],
      },
      seed,
    );
    expect(again.bookId).toBe(a.bookId);

    await unmergeBooks(db, mergeId, "owner");
    expect(await book(b.bookId)).toMatchObject({ redirectTo: null, visibility: "draft", pageCount: 700 });
    expect((await book(a.bookId))?.pageCount).toBeNull();
    expect((await book(a.bookId))?.confirmedAt).toBeNull();
    expect((await db.select().from(bookAuthors).where(eq(bookAuthors.bookId, a.bookId))).length).toBe(1);
    expect((await db.select().from(editions).where(eq(editions.bookId, b.bookId))).length).toBe(1);
  });

  it("refuses bad merges", async () => {
    const a = await ingestBook(db, hunter1, seed);
    await expect(mergeBooks(db, a.bookId, a.bookId, "owner")).rejects.toThrow(/itself/);
    await expect(mergeBooks(db, a.bookId, "nope", "owner")).rejects.toThrow(/not found/);
  });
});
