import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addConfirmation, ingestBook, mergeBooks, setVisibility, writeAiScores } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { bookScores, books, tags } from "../src/db/schema";
import {
  authorPage,
  bookPage,
  narratorPage,
  newAndUpcoming,
  seriesPage,
  tagIndex,
  tagLookup,
} from "../src/site";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
const opts = { displayMin: 0.6, minAppraisals: 5, now: "2026-10-01T12:00:00.000Z" };

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

async function book(
  title: string,
  extra: Partial<Parameters<typeof ingestBook>[1]> = {},
  publish = true,
): Promise<string> {
  const { bookId } = await ingestBook(
    db,
    { title, authors: [{ name: "Ann Writer" }], primaryGenre: "litrpg", ...extra },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  if (publish) {
    await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
    const gate = await setVisibility(db, bookId, "published");
    if (!gate.ok) throw new Error(`gate: ${gate.reason}`);
  }
  return bookId;
}

const slugOf = async (id: string) =>
  (await db.select({ slug: books.slug }).from(books).where(eq(books.id, id)))[0]?.slug ?? "";

describe("the book page", () => {
  it("shows the book with its series neighbors, editions, releases, tags and status screen", async () => {
    await book("Tower One", { series: { name: "The Tower", position: 1 } });
    const two = await book("Tower Two", {
      series: { name: "The Tower", position: 2 },
      tags: [
        { slug: "dungeon-core", confidence: 0.9 },
        { slug: "cozy", confidence: 0.3 },
      ],
      editions: [
        { format: "ebook", kindleUnlimited: true },
        { format: "audiobook", narrators: ["Nate Voice"], durationMinutes: 900 },
      ],
      releases: [{ kind: "audio", date: "2026-11-03" }],
    });
    await book("Tower Three", { series: { name: "The Tower", position: 3 } });
    await writeAiScores(
      db,
      two,
      [
        { key: "pacing", value: 8, confidence: 0.85 },
        { key: "number_go_up", value: 7, confidence: 0.85 },
        { key: "competent_mc", value: 9, confidence: 0.85 },
      ],
      5,
    );

    const r = await bookPage(db, await slugOf(two), opts);
    if (r.kind !== "found") throw new Error(r.kind);
    const p = r.data;
    expect(p.series?.prev?.title).toBe("Tower One");
    expect(p.series?.next?.title).toBe("Tower Three");
    expect(p.series?.count).toBe(3);
    expect(p.editions.map((e) => e.format).sort()).toEqual(["audiobook", "ebook"]);
    expect(p.editions.find((e) => e.format === "audiobook")?.narrators[0]?.name).toBe("Nate Voice");
    expect(p.editions.find((e) => e.format === "ebook")?.kindleUnlimited).toBe(true);
    expect(p.releases[0]?.date).toBe("2026-11-03");
    // Only tags at the display threshold show.
    expect(p.tags.flatMap((g) => g.tags.map((t) => t.slug))).toEqual(["dungeon-core"]);
    // Descriptive stats may show as estimates; judgment stats stay hidden until readers appraise.
    expect(p.stats.find((s) => s.key === "number_go_up")).toMatchObject({ value: 7, label: "Estimated" });
    expect(p.stats.find((s) => s.key === "competent_mc")).toMatchObject({ value: null, label: "???" });
    expect(p.dials.find((d) => d.key === "pacing")?.value).toBe(8);
    expect(p.confirmedBy).toEqual(["owner_check"]);
  });

  it("hides drafts and embargoed books, and sends merged books to the survivor", async () => {
    const draft = await book("Unconfirmed", {}, false);
    expect((await bookPage(db, await slugOf(draft), opts)).kind).toBe("missing");

    const secret = await book("Cover Reveal");
    await db.update(books).set({ embargoUntil: "2026-12-01T00:00:00.000Z" }).where(eq(books.id, secret));
    expect((await bookPage(db, await slugOf(secret), opts)).kind).toBe("missing");
    expect(
      (await bookPage(db, await slugOf(secret), { ...opts, now: "2026-12-02T00:00:00.000Z" })).kind,
    ).toBe("found");

    const winner = await book("Keeper");
    const loser = await book("Duplicate Keeper", { authors: [{ name: "Someone Else" }] });
    const loserSlug = await slugOf(loser);
    await mergeBooks(db, winner, loser, "owner");
    expect(await bookPage(db, loserSlug, opts)).toEqual({ kind: "redirect", slug: await slugOf(winner) });
    expect((await bookPage(db, "no-such-book", opts)).kind).toBe("missing");
  });

  it("shows the author's blurb only on a claimed listing", async () => {
    const id = await book("Blurbed", { blurb: "Written by the author." });
    await db.update(books).set({ summaryAi: "Our summary." }).where(eq(books.id, id));
    let r = await bookPage(db, await slugOf(id), opts);
    expect(r.kind === "found" && r.data.description).toEqual({ text: "Our summary.", by: "us" });
    await db
      .update(books)
      .set({ claimed: true, blurbAuthor: "Written by the author." })
      .where(eq(books.id, id));
    r = await bookPage(db, await slugOf(id), opts);
    expect(r.kind === "found" && r.data.description?.by).toBe("author");
  });

  it("labels a stat readers have appraised", async () => {
    const id = await book("Appraised");
    await db.insert(bookScores).values({
      bookId: id,
      key: "competent_mc",
      kind: "stat",
      value: 8.5,
      confidence: 0.9,
      crowdMean: 8.5,
      crowdN: 6,
      public: true,
    });
    const r = await bookPage(db, await slugOf(id), opts);
    expect(r.kind === "found" && r.data.stats.find((s) => s.key === "competent_mc")).toMatchObject({
      value: 8.5,
      label: "Readers say",
      appraisals: 6,
    });
  });
});

describe("series, author and narrator pages", () => {
  it("adds up a series and lists its upcoming releases", async () => {
    await book("Deep One", {
      series: { name: "Deep", position: 1 },
      pageCount: 400,
      editions: [{ format: "audiobook", durationMinutes: 600, narrators: ["Nate Voice"] }],
    });
    await book("Deep Two", {
      series: { name: "Deep", position: 2 },
      pageCount: 500,
      releases: [{ kind: "ebook", date: "2026-12-15" }],
    });
    const r = await seriesPage(db, "deep", { now: opts.now });
    if (r.kind !== "found") throw new Error(r.kind);
    expect(r.data.books.map((b) => b.title)).toEqual(["Deep One", "Deep Two"]);
    expect(r.data.totalPages).toBe(900);
    expect(r.data.audio).toEqual({ books: 1, minutes: 600 });
    expect(r.data.upcoming.map((u) => u.title)).toEqual(["Deep Two"]);
    expect(r.data.authors).toEqual([{ name: "Ann Writer", slug: "ann-writer" }]);

    const n = await narratorPage(db, "nate-voice", { now: opts.now });
    expect(n.kind === "found" && n.data.books.map((b) => [b.title, b.durationMinutes])).toEqual([
      ["Deep One", 600],
    ]);
  });

  it("groups an author's books by series", async () => {
    await book("Deep One", { series: { name: "Deep", position: 1 } });
    await book("Standalone Tale");
    await book("Hidden Draft", {}, false);
    const r = await authorPage(db, "ann-writer", { now: opts.now });
    if (r.kind !== "found") throw new Error(r.kind);
    expect(r.data.series.map((s) => [s.name, s.books.map((b) => b.title)])).toEqual([["Deep", ["Deep One"]]]);
    expect(r.data.standalone.map((b) => b.title)).toEqual(["Standalone Tale"]);
    // Unverified authors show no bio or links: nobody has confirmed them.
    expect(r.data.verified).toBe(false);
  });
});

describe("new and upcoming", () => {
  it("splits releases of public books around today, soonest and newest first", async () => {
    await book("Out Last Week", { releases: [{ kind: "ebook", date: "2026-09-24" }] });
    await book("Out Long Ago", { releases: [{ kind: "ebook", date: "2025-01-01" }] });
    await book("Coming Soon", { releases: [{ kind: "ebook", date: "2026-10-05" }] });
    await book("Coming Later", { releases: [{ kind: "audio", date: "2027-02-01" }] });
    await book("Private Draft", { releases: [{ kind: "ebook", date: "2026-10-02" }] }, false);
    const r = await newAndUpcoming(db, { now: opts.now });
    expect(r.recent.map((x) => x.title)).toEqual(["Out Last Week"]);
    expect(r.upcoming.map((x) => x.title)).toEqual(["Coming Soon", "Coming Later"]);
  });
});

describe("tags", () => {
  it("counts books per tag and follows retired tags to their replacement", async () => {
    await book("Core One", { tags: [{ slug: "dungeon-core", confidence: 0.9 }] });
    const index = await tagIndex(db, opts);
    expect(index.find((t) => t.slug === "dungeon-core")?.books).toBe(1);
    expect((await tagLookup(db, "dungeon-core")).kind).toBe("found");

    const [target] = await db.select().from(tags).where(eq(tags.slug, "dungeon-core"));
    await db.update(tags).set({ status: "retired", replacedBy: "dungeon-core" }).where(eq(tags.slug, "cozy"));
    expect(target).toBeDefined();
    expect(await tagLookup(db, "cozy")).toEqual({ kind: "redirect", slug: "dungeon-core" });
    expect((await tagLookup(db, "not-a-tag")).kind).toBe("missing");
  });
});

describe("editing release dates", () => {
  it("adds, confirms, moves and cancels, keeping a slipped date", async () => {
    const { setRelease, cancelRelease } = await import("../src/catalog");
    const { releases } = await import("../src/db/schema");
    const id = await book("Slippy");
    const now = new Date("2026-10-01T12:00:00Z");
    const added = await setRelease(db, id, { kind: "ebook", date: "Nov 2026" }, "admin", now);
    expect(added.change).toBe("added");
    expect((await setRelease(db, id, { kind: "ebook", date: "2026-11" }, "author", now)).change).toBe(
      "confirmed",
    );
    const moved = await setRelease(db, id, { kind: "ebook", date: "2027-01-15" }, "admin", now);
    expect(moved).toMatchObject({ change: "moved", previousDate: "2026-11-01" });
    const [row] = await db.select().from(releases).where(eq(releases.id, added.id));
    expect(row).toMatchObject({ date: "2027-01-15", datePrecision: "day", status: "slipped" });
    const upcoming = (await newAndUpcoming(db, { now: opts.now })).upcoming;
    expect(upcoming[0]).toMatchObject({ title: "Slippy", status: "slipped", previousDate: "2026-11-01" });
    await expect(setRelease(db, id, { kind: "ebook", date: "someday" }, "admin", now)).rejects.toThrow(
      /can't read/,
    );
    expect(await cancelRelease(db, id, added.id)).toBe(true);
    expect((await newAndUpcoming(db, { now: opts.now })).upcoming).toEqual([]);
  });
});

describe("feeds, sitemaps and robots.txt", () => {
  it("builds RSS and a calendar with only day-precise releases, escaped and folded", async () => {
    const { ics, releaseItem, rss } = await import("../src/site");
    await book("Knights & Dragons <Deluxe>", {
      releases: [
        { kind: "ebook", date: "2026-11-03" },
        { kind: "audio", date: "Q1 2027" },
      ],
    });
    const { upcoming } = await newAndUpcoming(db, { now: opts.now });
    expect(upcoming).toHaveLength(2);
    const feed = rss(
      { title: "T", link: "https://x/new", self: "https://x/feeds/releases.xml", description: "D" },
      upcoming.map((r) => releaseItem(r, "https://x")),
    );
    expect(feed).toContain("Knights &amp; Dragons &lt;Deluxe&gt;: Ebook, 3 Nov 2026");
    expect(feed).not.toContain("<Deluxe>");
    const cal = ics("A very long calendar name ".repeat(5), upcoming, "https://x");
    expect(cal.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(cal).toContain("DTSTART;VALUE=DATE:20261103");
    expect(cal).toContain("DTEND;VALUE=DATE:20261104");
    expect(cal.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(cal).toContain("SUMMARY:Knights & Dragons <Deluxe>: Ebook\\, 3 Nov 2026");
  });

  it("lists only public records in the sitemaps", async () => {
    const { sitemapCounts, sitemapEntries, sitemapNames, sitemapXml } = await import("../src/site");
    await book("Public One", { series: { name: "Pub", position: 1 } });
    await book(
      "Draft One",
      { series: { name: "Drafty", position: 1 }, authors: [{ name: "Drafty Author" }] },
      false,
    );
    const counts = await sitemapCounts(db, opts.now);
    expect(counts).toEqual({ books: 1, series: 1, authors: 1, narrators: 0 });
    expect(sitemapNames(counts)).toEqual(["pages", "tags", "posts", "books-1", "series-1", "authors-1"]);
    const entries = await sitemapEntries(db, "books", 1, opts.now);
    expect(entries.map((e) => e.path)).toEqual(["/books/public-one"]);
    expect(sitemapXml(entries, "https://readlitrpg.com")).toContain(
      "<loc>https://readlitrpg.com/books/public-one</loc>",
    );
  });

  it("welcomes search crawlers and turns away training-only crawlers", async () => {
    const { robotsTxt } = await import("../src/site");
    const txt = robotsTxt("https://readlitrpg.com");
    expect(txt).toMatch(/User-agent: GPTBot\n[\s\S]*Disallow: \/\n/);
    expect(txt).toContain("Sitemap: https://readlitrpg.com/sitemap.xml");
    expect(txt).not.toMatch(/User-agent: (Googlebot|OAI-SearchBot|PerplexityBot|Claude-SearchBot)\n/);
  });
});
