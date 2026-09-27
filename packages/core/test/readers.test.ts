import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addConfirmation, ingestBook, setVisibility } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  appraisals,
  bookMarks,
  emailConsents,
  follows,
  sessions,
  suppressions,
  users,
} from "../src/db/schema";
import {
  buildExport,
  confirmSubscription,
  createLibraryImport,
  deleteAccount,
  effectiveInputs,
  feedOwner,
  followedReleases,
  followState,
  followsFor,
  getReaderProfile,
  isSuppressed,
  issueFeedToken,
  LibraryImportError,
  levelFor,
  marksFor,
  parseLibrary,
  parseLinkKeys,
  processLibraryChunk,
  purgeUnconfirmed,
  requestSubscription,
  saveQuery,
  saveReaderProfile,
  setConsent,
  setFollow,
  setMark,
  signLink,
  suppress,
  unsubscribe,
  verifyLink,
} from "../src/readers";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
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
  return bookId;
}

async function reader(email = "reader@example.com") {
  const id = `01READER${email.length}${"0".repeat(26)}`.slice(0, 26);
  await db.insert(users).values({ id, email, state: "active", emailVerified: true });
  return id;
}

describe("signed links", () => {
  const keys = parseLinkKeys(JSON.stringify({ k2: "b".repeat(40), k1: "a".repeat(40) }));

  it("sign, verify, and refuse tampering, the wrong purpose and expired links", async () => {
    const t = await signLink(keys, "unsub", ["user1", "weekly_digest"]);
    expect(await verifyLink(keys, t, "unsub")).toEqual(["user1", "weekly_digest"]);
    expect(await verifyLink(keys, t, "mark")).toBeNull();
    const [body, sig] = t.split(".");
    expect(
      await verifyLink(keys, `${body}.${sig?.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`, "unsub"),
    ).toBeNull();
    const short = await signLink(keys, "export", ["x"], Date.now() - 1);
    expect(await verifyLink(keys, short, "export")).toBeNull();
  });

  it("keeps old links working after a key rotation", async () => {
    const old = parseLinkKeys(JSON.stringify({ k1: "a".repeat(40) }));
    const t = await signLink(old, "unsub", ["user1", "all"]);
    expect(await verifyLink(keys, t, "unsub")).toEqual(["user1", "all"]);
    expect(() => parseLinkKeys("{}")).toThrow();
    expect(() => parseLinkKeys(JSON.stringify({ k1: "short" }))).toThrow();
  });
});

describe("subscriptions", () => {
  it("double opt-in: pending until confirmed, then active and the address verified", async () => {
    const r = await requestSubscription(db, {
      email: "New@Example.com",
      lists: ["weekly_digest", "reading_list"],
      source: "quiz:x:y",
      ipHash: "abc",
    });
    if (r.status !== "confirm") throw new Error(r.status);
    const [u] = await db.select().from(users).where(eq(users.email, "new@example.com"));
    expect(u).toMatchObject({ state: "subscriber", emailVerified: false });
    expect(await confirmSubscription(db, "not-the-token-at-all-000000")).toBeNull();
    const c = await confirmSubscription(db, r.token);
    expect(c).toMatchObject({ userId: u?.id, source: "quiz:x:y" });
    expect(c?.lists.sort()).toEqual(["reading_list", "weekly_digest"]);
    const consents = await db.select().from(emailConsents);
    expect(
      consents.every((x) => x.status === "active" && x.confirmTokenHash === null && x.ipHash === "abc"),
    ).toBe(true);
    // The link works once.
    expect(await confirmSubscription(db, r.token)).toBeNull();
    // Asking again for an active list sends nothing.
    expect(
      (await requestSubscription(db, { email: "new@example.com", lists: ["weekly_digest"], source: "x" }))
        .status,
    ).toBe("already");
  });

  it("expires unconfirmed requests and forgets addresses left with nothing", async () => {
    const r = await requestSubscription(db, {
      email: "late@example.com",
      lists: ["weekly_digest"],
      source: "x",
    });
    if (r.status !== "confirm") throw new Error(r.status);
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await confirmSubscription(db, r.token, later)).toBeNull();
    expect(await purgeUnconfirmed(db, later)).toBe(2);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("never mails an address that complained, and 'unsubscribe from everything' sticks until a new confirmation", async () => {
    await suppress(db, "angry@example.com", "complaint");
    expect(
      (await requestSubscription(db, { email: "angry@example.com", lists: ["weekly_digest"], source: "x" }))
        .status,
    ).toBe("blocked");

    const id = await reader("gone@example.com");
    await setConsent(db, id, "weekly_digest", true);
    await setConsent(db, id, "release_alerts", true);
    await unsubscribe(db, id, "all");
    expect((await db.select().from(emailConsents)).every((c) => c.status === "unsubscribed")).toBe(true);
    expect(await isSuppressed(db, "gone@example.com", "marketing")).toBe(true);
    expect(await isSuppressed(db, "gone@example.com", "transactional")).toBe(false);
    const again = await requestSubscription(db, {
      email: "gone@example.com",
      lists: ["weekly_digest"],
      source: "x",
    });
    if (again.status !== "confirm") throw new Error(again.status);
    await confirmSubscription(db, again.token);
    expect(await isSuppressed(db, "gone@example.com", "marketing")).toBe(false);

    await suppress(db, "bounced@example.com", "bounce_hard");
    expect(await isSuppressed(db, "bounced@example.com", "transactional")).toBe(true);
    // Only a hash is stored.
    expect(JSON.stringify(await db.select().from(suppressions))).not.toContain("@");
  });
});

describe("taste profiles", () => {
  it("levels follow QUIZZES §4.2", () => {
    const base = {
      quizTaken: false,
      booksRated: 0,
      mustsAndNoes: false,
      appraisedBooks: 0,
      importedRatings: 0,
    };
    expect(levelFor(base)).toBe(1);
    expect(levelFor({ ...base, quizTaken: true })).toBe(2);
    expect(levelFor({ ...base, booksRated: 5 })).toBe(3);
    expect(levelFor({ ...base, mustsAndNoes: true })).toBe(4);
    expect(levelFor({ ...base, importedRatings: 20 })).toBe(5);
    expect(levelFor({ ...base, appraisedBooks: 3 })).toBe(5);
  });

  it("saves stated tastes, merges book marks, and levels up", async () => {
    const id = await reader();
    await saveReaderProfile(
      db,
      id,
      { quiz: { slug: "whats-your-litrpg-class", outcome: "min-maxer" } },
      { source: "quiz:whats-your-litrpg-class:min-maxer", readerClass: "min-maxer" },
    );
    expect((await getReaderProfile(db, id)).level).toBe(2);
    const slugs = [];
    for (const t of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]) {
      await book(t);
      slugs.push(t.toLowerCase());
    }
    for (const s of slugs.slice(0, 5)) await setMark(db, id, s, "loved");
    await setMark(db, id, "zeta", "dnf");
    const p = await getReaderProfile(db, id);
    expect(p.level).toBe(3);
    expect(p.readerClass).toBe("min-maxer");
    const inputs = await effectiveInputs(db, id);
    expect(inputs.loved).toHaveLength(5);
    expect(inputs.bounced).toEqual([{ book: "zeta" }]);
    expect(inputs.read?.sort()).toEqual([...slugs].sort());
    expect(inputs.quiz?.slug).toBe("whats-your-litrpg-class");
    await saveReaderProfile(db, id, { musts: ["competent_mc"], noes: ["harem"] });
    expect((await getReaderProfile(db, id)).level).toBe(4);
    await expect(saveReaderProfile(db, id, { musts: ["not_a_stat" as "competent_mc"] })).rejects.toThrow();
  });
});

describe("follows, marks and saved searches", () => {
  it("follows by slug, remembers the notification choice, and lists names and pages", async () => {
    const id = await reader();
    await book("Tower One", { series: { name: "The Tower", position: 1 } });
    await setFollow(db, id, "series", "the-tower", "instant");
    await setFollow(db, id, "author", "ann-writer", "digest");
    expect(await followState(db, id, "series", "the-tower")).toBe("instant");
    const list = await followsFor(db, id);
    expect(list.map((f) => [f.type, f.name, f.path])).toEqual(
      expect.arrayContaining([
        ["series", "The Tower", "/series/the-tower"],
        ["author", "Ann Writer", "/authors/ann-writer"],
      ]),
    );
    await setFollow(db, id, "series", "the-tower", null);
    expect(await followState(db, id, "series", "the-tower")).toBeNull();
    await expect(setFollow(db, id, "series", "nope", "digest")).rejects.toThrow(/nothing to follow/);
  });

  it("marks books, and removes a mark", async () => {
    const id = await reader();
    await book("Marked");
    await setMark(db, id, "marked", "want");
    expect((await marksFor(db, id)).map((m) => [m.slug, m.status])).toEqual([["marked", "want"]]);
    await setMark(db, id, "marked", null);
    expect(await marksFor(db, id)).toEqual([]);
    await expect(setMark(db, id, "missing", "loved")).rejects.toThrow();
  });

  it("gives a private calendar feed that shows followed releases, and can be revoked", async () => {
    const id = await reader();
    await book("Soon", {
      series: { name: "Soon Series", position: 1 },
      releases: [{ kind: "ebook", date: "2027-01-10" }],
    });
    await book("Unfollowed", {
      authors: [{ name: "Other" }],
      releases: [{ kind: "ebook", date: "2027-01-11" }],
    });
    await setFollow(db, id, "series", "soon-series", "digest");
    const token = await issueFeedToken(db, id);
    expect(await feedOwner(db, token)).toBe(id);
    const rel = await followedReleases(db, id, { from: "2026-01-01", to: "2028-01-01" });
    expect(rel.map((r) => r.title)).toEqual(["Soon"]);
    const next = await issueFeedToken(db, id);
    expect(await feedOwner(db, token)).toBeNull();
    expect(await feedOwner(db, next)).toBe(id);
  });

  it("caps saved matches and searches", async () => {
    const id = await reader();
    for (let i = 0; i < 20; i++) await saveQuery(db, id, { kind: "find", name: `s${i}`, params: "inc=cozy" });
    await expect(saveQuery(db, id, { kind: "find", name: "one more", params: "inc=cozy" })).rejects.toThrow(
      /20/,
    );
  });
});

describe("library imports", () => {
  const goodreads = [
    "Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Exclusive Shelf",
    '1,Alpha,Ann Writer,"Writer, Ann",,"=""""","=""9780593820247""",5,4.2,read',
    '2,"Beta (The Series, #2)",Ann Writer,"Writer, Ann",,"=""""","=""""",2,3.1,read',
    '3,Unknown Book,Nobody,"Nobody",,"=""""","=""""",0,3.9,to-read',
    '4,Reading Now,Ann Writer,"Writer, Ann",,"=""""","=""""",0,3.9,currently-reading',
  ].join("\n");

  it("reads Goodreads and StoryGraph exports and refuses other files", () => {
    const g = parseLibrary(goodreads);
    expect(g.source).toBe("goodreads");
    expect(g.rows.map((r) => [r.title, r.isbn, r.rating, r.status])).toEqual([
      ["Alpha", "9780593820247", 5, "loved"],
      ["Beta (The Series, #2)", null, 2, "read"],
      ["Unknown Book", null, null, "want"],
    ]);
    const sg = parseLibrary(
      [
        "Title,Authors,ISBN/UID,Format,Read Status,Star Rating",
        "Gamma,Ann Writer,,digital,did-not-finish,",
        "Delta,Ann Writer,,audio,read,4.5",
      ].join("\n"),
    );
    expect(sg.source).toBe("storygraph");
    expect(sg.rows.map((r) => [r.title, r.status, r.rating])).toEqual([
      ["Gamma", "dnf", null],
      ["Delta", "loved", 5],
    ]);
    expect(() => parseLibrary("a,b\n1,2")).toThrow(LibraryImportError);
  });

  it("matches rows to published books, marks them, and cleans up", async () => {
    const id = await reader();
    await book("Alpha", { editions: [{ format: "ebook", isbn: "9780593820247" }] });
    await book("Beta");
    await setMark(db, id, "beta", "loved");
    const { total } = await createLibraryImport(db, id, goodreads);
    expect(total).toBe(3);
    const r = await processLibraryChunk(db);
    expect(r).toMatchObject({ processed: 3, remaining: 0 });
    const marks = await marksFor(db, id);
    // Alpha matched by ISBN; Beta by title and author, but the reader's own mark wins.
    expect(marks.map((m) => [m.slug, m.status, m.rating]).sort()).toEqual([
      ["alpha", "loved", 5],
      ["beta", "loved", null],
    ]);
    expect((await processLibraryChunk(db)).importId).toBeNull();
  });
});

describe("export and deletion", () => {
  it("exports what we hold and deletes it all, keeping only a suppression hash", async () => {
    const id = await reader("leaving@example.com");
    await book("Kept");
    await setMark(db, id, "kept", "loved");
    await setFollow(db, id, "author", "ann-writer", "digest");
    await setConsent(db, id, "weekly_digest", true);
    await db.insert(appraisals).values({
      id: "ap1",
      userId: id,
      bookId: (await db.select().from(bookMarks))[0]?.bookId ?? "",
      key: "competent_mc",
      value: 8,
    });
    await db
      .insert(sessions)
      .values({ id: "s1", userId: id, token: "tok", expiresAt: new Date(Date.now() + 1e6) });
    const data = await buildExport(db, id);
    expect(data?.account.email).toBe("leaving@example.com");
    expect(data?.bookMarks.map((m) => m.slug)).toEqual(["kept"]);
    expect(data?.follows[0]?.name).toBe("Ann Writer");
    expect(data?.appraisals).toHaveLength(1);

    expect((await deleteAccount(db, id)).deleted).toBe(true);
    for (const table of [users, bookMarks, follows, emailConsents, appraisals, sessions]) {
      expect(await db.select().from(table)).toHaveLength(0);
    }
    expect(await isSuppressed(db, "leaving@example.com", "marketing")).toBe(true);
  });
});
