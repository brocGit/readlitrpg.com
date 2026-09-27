import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addConfirmation, cancelRelease, ingestBook, setRelease, setVisibility } from "../src/catalog";
import {
  buildDailyPost,
  buildMonthlyRoundups,
  buildWeeklyRoundup,
  collectCatalogTips,
  postReviewHandler,
  renderBody,
  saveAutoPost,
  weekStart,
} from "../src/content";
import { createDb, type Db } from "../src/db";
import { books, follows, inboxItems, newsTips, posts, releases, series } from "../src/db/schema";
import { SETTINGS } from "../src/settings/registry";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
const env = { origin: "https://readlitrpg.com", mediaOrigin: "https://media.readlitrpg.com" };
const settings = {
  "blog.auto_publish_roundups": false,
  "news.daily_min_items": 3,
  "blog.calendar": SETTINGS["blog.calendar"].default,
  "blog.publish_hour_utc": 13,
} as never;
const now = new Date();
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

async function book(title: string, extra: Partial<Parameters<typeof ingestBook>[1]> = {}) {
  const { bookId } = await ingestBook(
    db,
    { title, authors: [{ name: "Ann Writer" }], primaryGenre: "litrpg", ...extra },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  const [row] = await db
    .select({ slug: books.slug, seriesId: books.seriesId })
    .from(books)
    .where(eq(books.id, bookId));
  return { id: bookId, slug: row?.slug ?? "", seriesId: row?.seriesId ?? null };
}

describe("news tips from the catalog", () => {
  it("records announcements, date changes, cancellations and completed series once", async () => {
    const soon = await book("Iron Tower", { releases: [{ kind: "ebook", date: day(20) }] });
    const moved = await book("Deep Delve", { releases: [{ kind: "audio", date: day(10) }] });
    const off = await book("Lost Floor", { releases: [{ kind: "ebook", date: day(30) }] });
    const done = await book("Last Floor", { series: { name: "The Spire", position: 5 } });
    // The first look sees three announcements.
    expect(await collectCatalogTips(db, now)).toBe(3);
    const before = new Set((await db.select({ id: newsTips.id }).from(newsTips)).map((t) => t.id));

    await setRelease(db, moved.id, { kind: "audio", date: day(40) }, "admin");
    const [offRelease] = await db
      .select({ id: releases.id })
      .from(releases)
      .where(eq(releases.bookId, off.id));
    await cancelRelease(db, off.id, offRelease?.id ?? "");
    await db
      .update(series)
      .set({ status: "complete", updatedAt: new Date().toISOString() })
      .where(eq(series.id, done.seriesId ?? ""));
    await book("Brand New", { releases: [{ kind: "ebook", date: day(5) }] });

    expect(await collectCatalogTips(db, now)).toBe(4);
    const tips = (await db.select().from(newsTips)).filter((t) => !before.has(t.id));
    expect(tips.map((t) => [t.kind, t.subject]).sort()).toEqual([
      ["announced", "Brand New"],
      ["cancelled", "Lost Floor"],
      ["completed", "The Spire"],
      ["date_moved", "Deep Delve"],
    ]);
    expect(tips.find((t) => t.kind === "date_moved")?.data).toMatchObject({ from: day(10), to: day(40) });
    // Seen again an hour later: nothing new.
    expect(await collectCatalogTips(db, now)).toBe(0);
    expect(soon.id).toBeTruthy();
  });
});

describe("Today in LitRPG", () => {
  it("reports today's releases and the tips once, then marks the tips used", async () => {
    const out = await book("Out Today", { releases: [{ kind: "ebook", date: day(0) }] });
    const audio = await book("Heard Today", { releases: [{ kind: "audio", date: day(0) }] });
    await book("Next Week", { releases: [{ kind: "print", date: day(3) }] });
    await collectCatalogTips(db, now);

    const built = await buildDailyPost(db, day(0), now);
    expect(built.genKey).toBe(`daily:${day(0)}`);
    expect(built.title).toMatch(/^Today in LitRPG: /);
    expect(built.bodyMd).toContain(`[[book:${out.slug}]]`);
    expect(built.bodyMd).toContain("## New audiobooks");
    expect(built.bodyMd).toContain("## Newly announced");
    expect(built.bodyMd).toContain("## Coming this week");
    expect(built.dek).toMatch(/^1 book out today, 1 new audiobook and 1 new announcement\.$/);
    expect(built.data).toMatchObject({
      sections: expect.arrayContaining([{ heading: "Out today", refs: [out.slug] }]),
    });

    const saved = await saveAutoPost(db, built, env, settings, now);
    expect(saved.outcome).toBe("published");
    expect(saved.post.noindex).toBe(false);
    const segments = await renderBody(db, saved.post.bodyHtml);
    expect(segments.filter((s) => s.kind === "book").map((s) => s.kind === "book" && s.book.id)).toEqual([
      out.id,
      audio.id,
    ]);
    expect((await db.select().from(newsTips)).every((t) => t.status === "used")).toBe(true);
    expect((await saveAutoPost(db, built, env, settings, now)).outcome).toBe("exists");

    // Tomorrow's roundup doesn't repeat the announcement, and a thin day stays out of search.
    const tomorrow = await buildDailyPost(db, day(1), now);
    expect(tomorrow.bodyMd).not.toContain("## Newly announced");
    const thin = await saveAutoPost(db, tomorrow, env, settings, now);
    expect(thin.post.noindex).toBe(true);
  });
});

describe("roundups", () => {
  it("builds the week's roundup when there are enough books, and waits a day for a veto", async () => {
    const monday = weekStart(day(0));
    await book("One", { releases: [{ kind: "ebook", date: monday }] });
    expect(await buildWeeklyRoundup(db, now, 2)).toBeNull();
    await book("Two", { releases: [{ kind: "audio", date: monday }] });
    const built = await buildWeeklyRoundup(db, now, 2);
    expect(built?.genKey).toBe(`roundup:weekly:${monday}`);
    expect(built?.dek).toBe("1 new book and 1 audiobook out this week.");

    const saved = await saveAutoPost(db, built as NonNullable<typeof built>, env, settings, now);
    expect(saved.outcome).toBe("in_review");
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "post_review"));
    expect(item?.defaultAction).toBe("approve");
    await postReviewHandler.approve?.(db, item as NonNullable<typeof item>, {
      decidedBy: "owner",
      now,
      settings: settings as never,
    });
    const [post] = await db.select().from(posts).where(eq(posts.id, saved.post.id));
    expect(post?.status).toBe("published");
  });

  it("builds the monthly audiobook and most-followed roundups on their days", async () => {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 11));
    const month = first.toISOString().slice(0, 7);
    await book("Audio A", { releases: [{ kind: "audio", date: `${month}-10` }] });
    await book("Audio B", { releases: [{ kind: "audio", date: `${month}-20` }] });
    const onFirst = await buildMonthlyRoundups(db, first, 2);
    expect(onFirst.map((r) => r.genKey)).toEqual([`roundup:audio:${month}`]);

    const fifteenth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 11));
    const soon = (n: number) => new Date(fifteenth.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const a = await book("Wanted A", { releases: [{ kind: "ebook", date: soon(5) }] });
    const b = await book("Wanted B", { releases: [{ kind: "ebook", date: soon(9) }] });
    await book("Unwanted", { releases: [{ kind: "ebook", date: soon(7) }] });
    await db.insert(follows).values([
      { userId: "u1", targetType: "book", targetId: a.id },
      { userId: "u2", targetType: "book", targetId: a.id },
      { userId: "u1", targetType: "book", targetId: b.id },
    ]);
    const onFifteenth = await buildMonthlyRoundups(db, fifteenth, 2);
    expect(onFifteenth).toHaveLength(1);
    expect(onFifteenth[0]?.data).toMatchObject({ sections: [{ refs: [a.slug, b.slug] }] });
  });
});
