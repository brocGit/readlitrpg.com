import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addConfirmation, ingestBook, setVisibility } from "../src/catalog";
import {
  autoPostMarkdown,
  calendarEntries,
  claimNextSlot,
  createPost,
  lineDiff,
  listPosts,
  listRevisions,
  moveToSlot,
  postsForBook,
  publishDuePosts,
  publishedPost,
  renderBody,
  renderMarkdown,
  restoreRevision,
  SlotError,
  setPostStatus,
  shortcodesIn,
  updatePost,
  validateAutoPost,
} from "../src/content";
import { createDb, type Db } from "../src/db";
import { books, postBooks } from "../src/db/schema";
import { SETTINGS } from "../src/settings/registry";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
const env = { origin: "https://readlitrpg.com", mediaOrigin: "https://media.readlitrpg.com" };
const cal = {
  "blog.calendar": SETTINGS["blog.calendar"].default,
  "blog.publish_hour_utc": 13,
};

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
  const [row] = await db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId));
  return { id: bookId, slug: row?.slug ?? "" };
}

describe("markdown", () => {
  it("escapes HTML, drops unsafe links and keeps the page's only h1", () => {
    const html = renderMarkdown(
      "# Big\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [in](/books/a) [out](https://example.com)\n\n![a](https://evil.example/x.png) ![b](https://media.readlitrpg.com/c/1.webp)",
      env,
    );
    expect(html).toContain("<h2>Big</h2>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="/books/a">in</a>');
    expect(html).toContain('<a href="https://example.com" rel="noopener">out</a>');
    expect(html).not.toContain("evil.example");
    expect(html).toContain('<img src="https://media.readlitrpg.com/c/1.webp" alt="b" loading="lazy" />');
  });

  it("marks guest and sponsored links", () => {
    expect(renderMarkdown("[x](https://a.example)", { ...env, links: "ugc" })).toContain(
      'rel="ugc nofollow noopener"',
    );
    expect(renderMarkdown("[x](https://a.example)", { ...env, links: "sponsored" })).toContain(
      'rel="sponsored noopener"',
    );
    expect(renderMarkdown("[x](https://readlitrpg.com/new)", { ...env, links: "ugc" })).not.toContain("rel=");
  });
});

describe("shortcodes", () => {
  it("parses every kind, in markdown and in rendered HTML", () => {
    const md =
      '[[book:the-tower]] [[series:01ABC]] [[author:ann]] [[releases tag="dungeon-core" month="2026-11"]] [[newsletter-signup]]';
    const codes = shortcodesIn(md);
    expect(codes).toEqual([
      { kind: "book", ref: "the-tower" },
      { kind: "series", ref: "01ABC" },
      { kind: "author", ref: "ann" },
      { kind: "releases", tag: "dungeon-core", month: "2026-11" },
      { kind: "newsletter" },
    ]);
    expect(shortcodesIn(renderMarkdown(md, env))).toEqual(codes);
  });

  it("renders live cards for lone shortcodes and links inside sentences", async () => {
    const tower = await book("The Iron Tower", {
      series: { name: "Iron", position: 1 },
      releases: [{ kind: "ebook", date: "2026-11-03" }],
      tags: [{ slug: "dungeon-core", confidence: 0.9 }],
    });
    const html = renderMarkdown(
      `Start with [[book:${tower.slug}]] today.\n\n[[book:${tower.id}]]\n\n[[book:nope]]\n\n[[releases tag="dungeon-core" month="2026-11"]]\n\n[[newsletter-signup]]`,
      env,
    );
    const segments = await renderBody(db, html, { now: "2026-10-01T00:00:00.000Z" });
    expect(segments[0]).toEqual({
      kind: "html",
      html: `<p>Start with <a href="/books/${tower.slug}">The Iron Tower</a> today.</p>\n`,
    });
    expect(segments[1]).toMatchObject({ kind: "book", book: { id: tower.id, title: "The Iron Tower" } });
    const releases = segments.find((s) => s.kind === "releases");
    expect(releases).toMatchObject({ kind: "releases", title: "dungeon core releases, November 2026" });
    expect(releases?.kind === "releases" && releases.releases.map((r) => r.title)).toEqual([
      "The Iron Tower",
    ]);
    expect(segments.at(-1)).toEqual({ kind: "newsletter" });
    // An unknown ref renders nothing, and nothing else.
    expect(segments.filter((s) => s.kind === "book")).toHaveLength(1);
  });
});

describe("the automated-post validator (§14.4)", () => {
  const input = {
    books: [
      { id: "B1", title: "The Iron Tower" },
      { id: "B2", title: "Deep Delve" },
    ],
    facts: { week: "2026-W41", count: 2, dates: ["2026-10-05"] },
    minBooks: 2,
    otherTitles: ["Dungeon Crawler Carl"],
  };
  const good = {
    title: "New LitRPG releases: week 41",
    dek: "2 books out this week.",
    sections: [
      { heading: "Out now", intro_md: "Start with [[book:B1]], then B2's sequel.", book_ids: ["B1", "B2"] },
    ],
    outro_md: "",
  };

  it("accepts prose that names books only by shortcode and numbers from the input", () => {
    expect(validateAutoPost(good, input)).toEqual([]);
    expect(autoPostMarkdown(good)).toBe(
      "## Out now\n\nStart with [[book:B1]], then B2's sequel.\n\n[[book:B1]]\n\n[[book:B2]]",
    );
  });

  it("refuses invented books, bare titles, stray numbers and links", () => {
    const errors = validateAutoPost(
      {
        ...good,
        dek: "Better than Dungeon Crawler Carl, with 400 pages of fights.",
        sections: [
          { heading: "Out now", intro_md: "See [[book:B9]] and https://x.example", book_ids: ["B1", "B9"] },
        ],
      },
      input,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "sections.0: B9 wasn't in the input",
        "only 1 books; at least 2 needed",
        'dek: names "Dungeon Crawler Carl" without a shortcode',
        "dek: numbers not in the input (400)",
        "sections.0.intro_md: B9 wasn't in the input",
        "sections.0.intro_md: no links or HTML",
      ]),
    );
  });
});

describe("posts", () => {
  it("keeps revisions, the books a post mentions, and one post per generation key", async () => {
    const tower = await book("The Iron Tower");
    const post = await createPost(
      db,
      { type: "owner", title: "Why towers", bodyMd: `Read [[book:${tower.slug}]].`, createdBy: "u1" },
      env,
    );
    expect(post.slug).toBe("why-towers");
    expect(post.bodyHtml).toContain(`[[book:${tower.slug}]]`);
    expect(await db.select().from(postBooks)).toEqual([{ postId: post.id, bookId: tower.id }]);

    await updatePost(db, post.id, { bodyMd: "Changed." }, env, "u1");
    await updatePost(db, post.id, { seoTitle: "Towers" }, env, "u1");
    const revisions = await listRevisions(db, post.id);
    expect(revisions).toHaveLength(2);
    expect(await db.select().from(postBooks)).toEqual([]);
    const oldest = revisions.at(-1);
    const restored = await restoreRevision(db, post.id, oldest?.id ?? "", env, "u1");
    expect(restored.bodyMd).toBe(`Read [[book:${tower.slug}]].`);
    expect(await listRevisions(db, post.id)).toHaveLength(3);

    const a = await createPost(
      db,
      { type: "daily", title: "Today in LitRPG", genKey: "daily:2026-10-05" },
      env,
    );
    const b = await createPost(
      db,
      { type: "daily", title: "Today in LitRPG", genKey: "daily:2026-10-05" },
      env,
    );
    expect(b.id).toBe(a.id);
  });

  it("publishes scheduled posts when their time comes, and only published posts are public", async () => {
    const tower = await book("The Iron Tower");
    const post = await createPost(db, { type: "owner", title: "Soon", bodyMd: `[[book:${tower.id}]]` }, env);
    await setPostStatus(db, post.id, "scheduled", { publishAt: "2026-10-05T13:00:00.000Z" });
    expect(await publishedPost(db, post.slug)).toBeNull();
    expect(await publishDuePosts(db, new Date("2026-10-05T12:59:00Z"))).toEqual([]);
    expect(await publishDuePosts(db, new Date("2026-10-05T13:00:00Z"))).toEqual([post.id]);
    const live = await publishedPost(db, post.slug);
    expect(live?.publishedAt).toBe("2026-10-05T13:00:00.000Z");
    expect((await listPosts(db, { types: ["owner"] })).map((p) => p.title)).toEqual(["Soon"]);
    expect((await listPosts(db, { types: ["news"] })).length).toBe(0);
    expect((await postsForBook(db, tower.id)).map((p) => p.slug)).toEqual([post.slug]);
  });

  it("diffs revisions line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { op: "same", line: "a" },
      { op: "del", line: "b" },
      { op: "same", line: "c" },
      { op: "add", line: "d" },
    ]);
  });
});

describe("the editorial calendar", () => {
  it("gives approved posts the next open slot of their kind", async () => {
    const one = await createPost(db, { type: "guest", title: "Guest one" }, env);
    const two = await createPost(db, { type: "guest", title: "Guest two" }, env);
    // Monday 2026-10-05 14:00 UTC: Monday's hour has passed; guest slots are Tuesday and Thursday.
    const from = new Date("2026-10-05T14:00:00Z");
    expect(await claimNextSlot(db, one.id, "guest", cal, from)).toBe("2026-10-06T13:00:00.000Z");
    expect(await claimNextSlot(db, two.id, "guest", cal, from)).toBe("2026-10-08T13:00:00.000Z");
    // Claiming again moves the post rather than holding two slots.
    expect(await claimNextSlot(db, one.id, "guest", cal, new Date("2026-10-07T00:00:00Z"))).toBe(
      "2026-10-13T13:00:00.000Z",
    );
    await expect(moveToSlot(db, one.id, "guest", "2026-10-08", cal)).rejects.toThrow(SlotError);
    expect(await moveToSlot(db, one.id, "guest", "2026-10-06", cal)).toBe("2026-10-06T13:00:00.000Z");
    expect((await calendarEntries(db, "2026-10-01")).map((e) => [e.date, e.title])).toEqual([
      ["2026-10-06", "Guest one"],
      ["2026-10-08", "Guest two"],
    ]);
    await expect(claimNextSlot(db, one.id, "owner", cal, from)).rejects.toThrow(SlotError);
  });
});
