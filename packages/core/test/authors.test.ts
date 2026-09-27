import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTHOR_INBOX_HANDLERS,
  acceptInvite,
  answerAsk,
  askUrl,
  bookHistory,
  checkVerification,
  claimProfile,
  createAsk,
  createProfile,
  dashboardBooks,
  dueReleaseAsks,
  editBook,
  inviteLink,
  membershipsFor,
  normalizeDomain,
  planEdit,
  readAsk,
  readInvite,
  startVerification,
  submitBook,
} from "../src/authors";
import { ingestBook, rolloverReleases, writeBookFields } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  auditLog,
  authorMembers,
  authorNotices,
  authorSubmissions,
  authors,
  bookAuthors,
  books,
  catalogConfirmations,
  changeNotifications,
  inboxItems,
  releases,
  users,
} from "../src/db/schema";
import { decideWithHandler, getInboxItem, runInboxDefaults } from "../src/inbox";
import { parseLinkKeys } from "../src/readers";
import { defaultSettings } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
const settings = defaultSettings();
const keys = parseLinkKeys('{"k1":"test-link-key-that-is-at-least-32-chars"}');

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

async function user(email: string) {
  const id = `u-${email.split("@")[0]}`;
  await db.insert(users).values({ id, email, state: "active", emailVerified: true });
  return id;
}

async function profile(userId: string, name: string, trust: "T0" | "T1" = "T0", links: string[] = []) {
  const r = await createProfile(db, userId, { name });
  if (r.status !== "created") throw new Error("expected a new profile");
  await db.update(authors).set({ trustLevel: trust, links }).where(eq(authors.id, r.authorId));
  return r.authorId;
}

const form = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  primaryGenre: "litrpg",
  aiUse: "human",
  harem: "none",
  romanceLevel: 0,
  tags: ["system-apocalypse"],
  releases: [{ kind: "ebook", date: "2027-03-14" }],
  ...extra,
});

describe("profiles and members", () => {
  it("a first claim makes the claimant owner; a second goes to the inbox", async () => {
    const [a, b] = [await user("a@example.com"), await user("b@example.com")];
    const { bookId } = await ingestBook(
      db,
      { title: "Seeded Book", authors: [{ name: "Pen Name" }] },
      { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    const [{ authorId } = { authorId: "" }] = await db
      .select({ authorId: bookAuthors.authorId })
      .from(bookAuthors)
      .where(eq(bookAuthors.bookId, bookId));
    expect(await claimProfile(db, a, authorId)).toEqual({ status: "claimed" });
    expect(await claimProfile(db, a, authorId)).toEqual({ status: "already" });
    expect(await claimProfile(db, b, authorId)).toEqual({ status: "conflict" });
    expect((await db.select().from(inboxItems)).map((i) => i.type)).toEqual(["claim_conflict"]);
    expect(await membershipsFor(db, a)).toEqual([{ authorId, role: "owner", trust: "T0" }]);
    // Creating a profile for a known name points at the existing one instead.
    expect(await createProfile(db, b, { name: "pen  NAME" })).toEqual({ status: "exists", authorId });
  });

  it("invites work only for the invited address", async () => {
    const owner = await user("owner@example.com");
    const authorId = await profile(owner, "Team Author");
    const url = await inviteLink(keys, "https://readlitrpg.com", {
      authorId,
      email: "PA@example.com",
      role: "editor",
    });
    const invite = await readInvite(db, keys, url.split("/").pop() ?? "");
    expect(invite).toMatchObject({
      authorId,
      email: "pa@example.com",
      role: "editor",
      authorName: "Team Author",
    });
    const pa = await user("pa@example.com");
    const other = await user("other@example.com");
    if (!invite) throw new Error("invite");
    expect(await acceptInvite(db, invite, { userId: other, email: "other@example.com" })).toBe(
      "wrong_account",
    );
    expect(await acceptInvite(db, invite, { userId: pa, email: "pa@example.com" })).toBe("added");
    expect((await membershipsFor(db, pa))[0]?.role).toBe("editor");
  });
});

describe("verification", () => {
  const site = (body: string) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes("/.well-known/readlitrpg-verify.txt")
        ? new Response(body)
        : new Response("nope", { status: 404 });
    }) as typeof fetch;

  it("a code on a site the profile already lists verifies at once and moves T0 to T1", async () => {
    const u = await user("me@example.com");
    const authorId = await profile(u, "Listed Author", "T0", ["https://www.listedauthor.com/"]);
    const req = await startVerification(db, {
      authorId,
      userId: u,
      method: "website_file",
      target: "https://ListedAuthor.com/about",
    });
    expect(req.target).toBe("listedauthor.com");
    expect(req.code).toMatch(/^rlr-verify-[A-Z2-9]{6}$/);
    expect(
      await checkVerification(db, req.id, { userEmail: "me@example.com", fetch: site("nothing") }),
    ).toMatchObject({
      status: "pending",
    });
    expect(
      await checkVerification(db, req.id, { userEmail: "me@example.com", fetch: site(`code: ${req.code}`) }),
    ).toEqual({
      status: "verified",
    });
    const [a] = await db.select().from(authors).where(eq(authors.id, authorId));
    expect(a?.trustLevel).toBe("T1");
    expect(a?.verifiedAt).toBeTruthy();
    expect((await db.select().from(auditLog)).map((r) => r.action)).toContain("author.verify");
  });

  it("a code on a site the profile doesn't list yet goes to the owner, who can approve it", async () => {
    const u = await user("me@example.com");
    const authorId = await profile(u, "New Author");
    const req = await startVerification(db, {
      authorId,
      userId: u,
      method: "website_file",
      target: "newauthor.com",
    });
    expect(
      await checkVerification(db, req.id, { userEmail: "me@example.com", fetch: site(req.code) }),
    ).toMatchObject({
      status: "review",
    });
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "verification_manual"));
    expect(item?.payload).toMatchObject({ requestId: req.id, code: req.code, target: "newauthor.com" });
    if (!item) throw new Error("item");
    await decideWithHandler(db, item, "approve", AUTHOR_INBOX_HANDLERS, {
      decidedBy: "admin1",
      now: new Date(),
      settings,
    });
    const [a] = await db.select().from(authors).where(eq(authors.id, authorId));
    expect(a?.trustLevel).toBe("T1");
    expect(a?.links).toContain("https://newauthor.com/");
    expect((await db.select().from(authorNotices)).map((n) => n.kind)).toEqual(["verified"]);
  });

  it("DNS, email domain and Bluesky checks read the right places; hosts are normalized", async () => {
    const u = await user("writer@mail.dnsauthor.com");
    const authorId = await profile(u, "Dns Author", "T0", [
      "https://dnsauthor.com",
      "https://bsky.app/profile/dns.bsky.social",
    ]);
    const dns = await startVerification(db, {
      authorId,
      userId: u,
      method: "dns_txt",
      target: "dnsauthor.com",
    });
    const doh = (async () =>
      Response.json({ Answer: [{ data: `"${dns.code}"` }] })) as unknown as typeof fetch;
    expect((await checkVerification(db, dns.id, { userEmail: "x@y.z", fetch: doh })).status).toBe("verified");
    const email = await startVerification(db, {
      authorId,
      userId: u,
      method: "email_domain",
      target: "dnsauthor.com",
    });
    expect((await checkVerification(db, email.id, { userEmail: "writer@mail.dnsauthor.com" })).status).toBe(
      "verified",
    );
    const sky = await startVerification(db, {
      authorId,
      userId: u,
      method: "bluesky",
      target: "@DNS.bsky.social",
    });
    const bsky = (async () =>
      Response.json({ handle: "dns.bsky.social", description: `hi ${sky.code}` })) as unknown as typeof fetch;
    expect((await checkVerification(db, sky.id, { userEmail: "x@y.z", fetch: bsky })).status).toBe(
      "verified",
    );
    expect(normalizeDomain("http://10.0.0.1")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
  });
});

describe("submissions", () => {
  it("an unverified author's book waits; approval creates and publishes it, credited to their profile", async () => {
    const u = await user("new@example.com");
    // A namesake already exists: the submission must not attach to it.
    await ingestBook(
      db,
      { title: "Other", authors: [{ name: "Same Name" }] },
      { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    const [namesake] = await db.select({ id: authors.id }).from(authors);
    const authorId = (await createProfile(db, u, { name: "Unique Name" })).authorId;
    await db.update(authors).set({ name: "Same Name" }).where(eq(authors.id, authorId));
    const r = await submitBook(db, { userId: u, authorId, settings }, form("First Book"));
    expect(r.outcome).toBe("in_review");
    expect(await db.select().from(books).where(eq(books.title, "First Book"))).toEqual([]);
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "listing_unverified"));
    expect(item?.defaultAction).toBe("approve");
    if (!item) throw new Error("item");
    await decideWithHandler(db, item, "approve", AUTHOR_INBOX_HANDLERS, {
      decidedBy: "admin1",
      now: new Date(),
      settings,
    });
    const [book] = await db.select().from(books).where(eq(books.title, "First Book"));
    expect(book?.visibility).toBe("published");
    const credited = await db
      .select({ id: bookAuthors.authorId })
      .from(bookAuthors)
      .where(eq(bookAuthors.bookId, book?.id ?? ""));
    expect(credited.map((c) => c.id)).toEqual([authorId]);
    expect(credited.map((c) => c.id)).not.toContain(namesake?.id);
    expect((await db.select().from(catalogConfirmations)).some((c) => c.source === "author_claim")).toBe(
      true,
    );
    expect((await db.select().from(authorNotices)).map((n) => n.kind)).toEqual(["listing_published"]);
  });

  it("a verified author publishes at once; the inbox default approves an unverified one after 72 hours", async () => {
    const [v, t0] = [await user("v@example.com"), await user("t0@example.com")];
    const verified = await profile(v, "Verified One", "T1");
    const r = await submitBook(
      db,
      { userId: v, authorId: verified, settings },
      form("Instant Book", { dials: { pacing: 9 } }),
    );
    expect(r.outcome).toBe("published");
    const unverified = await profile(t0, "Unverified One");
    const now = new Date("2026-10-01T10:00:00Z");
    await submitBook(db, { userId: t0, authorId: unverified, settings, now }, form("Waiting Book"));
    expect(
      await runInboxDefaults(db, new Date("2026-10-03T10:00:00Z"), {
        handlers: AUTHOR_INBOX_HANDLERS,
        settings,
      }),
    ).toBe(0);
    expect(
      await runInboxDefaults(db, new Date("2026-10-04T10:01:00Z"), {
        handlers: AUTHOR_INBOX_HANDLERS,
        settings,
      }),
    ).toBe(1);
    const [waiting] = await db.select().from(books).where(eq(books.title, "Waiting Book"));
    expect(waiting?.visibility).toBe("published");
  });

  it("a book that is someone else's (same ASIN) waits for the owner and changes nothing", async () => {
    const other = await ingestBook(
      db,
      { title: "Their Book", authors: [{ name: "Them" }], links: ["https://www.amazon.com/dp/B0ABCDEFGH"] },
      { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    const u = await user("me@example.com");
    const mine = await profile(u, "Me Author", "T1");
    const r = await submitBook(
      db,
      { userId: u, authorId: mine, settings },
      form("My Book", { links: ["https://www.amazon.com/dp/B0ABCDEFGH"] }),
    );
    expect(r.outcome).toBe("in_review");
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.subjectType, "submission"));
    expect(item?.type).toBe("possible_duplicate");
    const [theirs] = await db.select().from(books).where(eq(books.id, other.bookId));
    expect(theirs?.title).toBe("Their Book");
  });

  it("refuses a form without an AI-use answer", async () => {
    const u = await user("me@example.com");
    const a = await profile(u, "Form Author", "T1");
    await expect(
      submitBook(db, { userId: u, authorId: a, settings }, form("X", { aiUse: "unknown" })),
    ).rejects.toThrow(/AI/);
  });
});

describe("editing rules (§10.4)", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const state = (trust: "T0" | "T1" | "T-1", released = false) => ({
    trust,
    released,
    releases: [{ id: "r1", kind: "ebook", date: "2026-10-03", precision: "day", status: "confirmed" }],
  });
  const t0h = 72;

  it("verified: most edits apply now; protected ones wait or approve later", () => {
    expect(planEdit(state("T1"), { blurb: "New", tags: ["litrpg"] }, now, t0h)).toEqual({
      immediate: { blurb: "New", tags: ["litrpg"] },
      protected: [],
    });
    expect(
      planEdit(state("T1"), { release: { kind: "ebook", date: "2026-12-01" } }, now, t0h).protected,
    ).toEqual([
      {
        patch: { release: { kind: "ebook", date: "2026-12-01" } },
        reason: "release date within 72 hours of release, or after it",
        afterHours: 24,
      },
    ]);
    expect(planEdit(state("T1", true), { title: "Renamed" }, now, t0h).protected[0]?.afterHours).toBeNull();
    expect(planEdit(state("T1"), { title: "Renamed" }, now, t0h).immediate).toEqual({ title: "Renamed" });
    expect(planEdit(state("T1"), { series: { name: "Other" } }, now, t0h).protected[0]?.reason).toBe(
      "series reassignment",
    );
  });

  it("unverified edits are reviewed, restricted ones wait, and hiding is always immediate", () => {
    const t0 = planEdit(state("T0"), { blurb: "x", hidden: true }, now, t0h);
    expect(t0.immediate).toEqual({ hidden: true });
    expect(t0.protected).toEqual([{ patch: { blurb: "x" }, reason: "unverified author", afterHours: 72 }]);
    expect(planEdit(state("T-1"), { blurb: "x" }, now, t0h).protected[0]?.afterHours).toBeNull();
  });

  it("applies the immediate part and queues the rest; approving the rest applies it", async () => {
    const u = await user("me@example.com");
    const authorId = await profile(u, "Edit Author", "T1");
    const r = await submitBook(
      db,
      { userId: u, authorId, settings },
      form("Editable", { releases: [{ kind: "ebook", date: "2026-10-03" }] }),
    );
    if (r.outcome !== "published") throw new Error("expected publish");
    const ctx = { userId: u, authorId, trust: "T1" as const, settings, now };
    const out = await editBook(
      db,
      r.bookId,
      { blurb: "A new blurb", release: { kind: "ebook", date: "2026-10-20" } },
      ctx,
    );
    expect(out.applied).toContain("blurbAuthor");
    expect(out.queued).toHaveLength(1);
    const [b] = await db.select().from(books).where(eq(books.id, r.bookId));
    expect(b?.blurbAuthor).toBe("A new blurb");
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.type, "protected_change"));
    if (!item) throw new Error("item");
    await decideWithHandler(db, item, "approve", AUTHOR_INBOX_HANDLERS, {
      decidedBy: "admin1",
      now,
      settings,
    });
    const [rel] = await db.select().from(releases).where(eq(releases.bookId, r.bookId));
    expect(rel?.date).toBe("2026-10-20");
    expect((await getInboxItem(db, item.id))?.status).toBe("approved");
  });
});

describe("change notifications, dashboard and asks", () => {
  it("records changes by others for claimed authors only, and lists history", async () => {
    const u = await user("me@example.com");
    const authorId = await profile(u, "Claimed Author", "T1");
    const r = await submitBook(db, { userId: u, authorId, settings }, form("Watched Book"));
    if (r.outcome !== "published") throw new Error("expected publish");
    expect(await db.select().from(changeNotifications)).toEqual([]);
    await writeBookFields(db, r.bookId, [{ field: "summaryAi", value: "A summary." }], { source: "ai" });
    const rows = await db.select().from(changeNotifications);
    expect(rows.map((c) => [c.authorId, c.summary])).toEqual([
      [authorId, "An editorial run changed the summary"],
    ]);
    const history = await bookHistory(db, r.bookId);
    expect(history.some((h) => h.who === "An editorial run" && h.field === "summary")).toBe(true);
    expect(history.some((h) => h.who === "You" && h.field === "title")).toBe(true);
    const [dash] = await dashboardBooks(db, [authorId]);
    expect(dash?.todos).toContain("Add a cover");
    expect(dash?.completeness).toBeGreaterThan(0);
  });

  it("asks 14 days out, once; the answer is single use; rollover marks releases out", async () => {
    const u = await user("me@example.com");
    const authorId = await profile(u, "Ask Author", "T1");
    const r = await submitBook(
      db,
      { userId: u, authorId, settings },
      form("Soon Book", { releases: [{ kind: "ebook", date: "2026-10-15" }] }),
    );
    if (r.outcome !== "published") throw new Error("expected publish");
    const now = new Date("2026-10-01T15:00:00Z");
    const due = await dueReleaseAsks(db, now);
    expect(due.map((d) => [d.title, d.stage])).toEqual([["Soon Book", "t14"]]);
    const askId = (await createAsk(db, due[0] ?? (undefined as never), now)) ?? "";
    expect(await createAsk(db, due[0] ?? (undefined as never), now)).toBeNull();
    expect(await dueReleaseAsks(db, now)).toEqual([]);
    const token = (await askUrl(keys, "https://x", askId, u, now.getTime())).split("/").pop() ?? "";
    const ask = await readAsk(db, keys, token);
    if (!ask) throw new Error("ask");
    const ctx = { trust: "T1" as const, authorId, settings, now };
    expect(await answerAsk(db, ask, { ...ctx, answer: "confirmed" })).toBe("done");
    expect(await answerAsk(db, ask, { ...ctx, answer: "delayed" })).toBe("already");
    expect(await rolloverReleases(db, new Date("2026-10-15T18:00:00Z"))).toBe(1);
    const [rel] = await db.select().from(releases).where(eq(releases.bookId, r.bookId));
    expect(rel?.status).toBe("released");
  });
});

describe("account deletion keeps the profile", () => {
  it("drops the membership and keeps the author and their books", async () => {
    const { deleteAccount } = await import("../src/readers");
    const u = await user("me@example.com");
    const authorId = await profile(u, "Leaving Author", "T1");
    await submitBook(db, { userId: u, authorId, settings }, form("Stays"));
    await deleteAccount(db, u);
    expect(await db.select().from(authorMembers)).toEqual([]);
    expect((await db.select().from(authors).where(eq(authors.id, authorId))).length).toBe(1);
    const [sub] = await db.select().from(authorSubmissions);
    expect(sub?.userId).toBeNull();
    expect(
      await db
        .select()
        .from(books)
        .where(and(eq(books.title, "Stays"), eq(books.visibility, "published"))),
    ).toHaveLength(1);
  });
});
