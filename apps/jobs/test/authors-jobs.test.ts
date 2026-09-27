import { createProfile, notifyAuthor, submitBook } from "@rlr/core/authors";
import { writeBookFields } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import { parseLinkKeys, verifyLink } from "@rlr/core/readers";
import { authorNotices, authors, changeNotifications, releaseAsks, releases, users } from "@rlr/core/schema";
import { defaultSettings } from "@rlr/core/settings";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1, TestKV } from "@rlr/core/testing";
import { emailJobSchema } from "@rlr/email";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { rollover, sendAuthorNotices, sendChangeDigests, sendReleaseAsks } from "../src/jobs/authors";
import type { JobContext } from "../src/jobs/types";

class FakeQueue {
  readonly sent: Record<string, unknown>[] = [];
  async send(body: Record<string, unknown>) {
    expect(emailJobSchema.safeParse(body).success).toBe(true);
    this.sent.push(body);
  }
}

const KEYS = '{"k1":"test-link-key-that-is-at-least-32-chars"}';
const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
const settings = defaultSettings();
let db: Db;
let queue: FakeQueue;

const ctx = (now: Date): JobContext =>
  ({
    db,
    log,
    now,
    env: {
      CONFIG: new TestKV().asKV(),
      Q_EMAIL: queue,
      PUBLIC_ORIGIN: "https://readlitrpg.com",
      LINK_SIGNING_KEYS: KEYS,
    },
  }) as unknown as JobContext;

async function verifiedAuthor(email: string, name: string) {
  const id = `u-${email.split("@")[0]}`;
  await db.insert(users).values({ id, email, state: "active", emailVerified: true });
  const r = await createProfile(db, id, { name });
  if (r.status !== "created") throw new Error("profile");
  await db.update(authors).set({ trustLevel: "T1" }).where(eq(authors.id, r.authorId));
  return { userId: id, authorId: r.authorId };
}

async function book(a: { userId: string; authorId: string }, title: string, date: string) {
  const r = await submitBook(
    db,
    { userId: a.userId, authorId: a.authorId, settings },
    {
      title,
      primaryGenre: "litrpg",
      aiUse: "human",
      harem: "none",
      romanceLevel: 0,
      releases: [{ kind: "ebook", date }],
    },
  );
  if (r.outcome !== "published") throw new Error("expected publish");
  return r.bookId;
}

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  queue = new FakeQueue();
  await syncTaxonomy(db);
});

describe("author jobs", () => {
  it("emails notices to the member they name, or to the owners, once", async () => {
    const a = await verifiedAuthor("owner@example.com", "Notice Author");
    await notifyAuthor(db, {
      authorId: a.authorId,
      kind: "listing_published",
      payload: { title: "Book One", slug: "book-one" },
    });
    expect(await sendAuthorNotices(ctx(new Date()))).toBe(1);
    expect(queue.sent[0]).toMatchObject({
      to: "owner@example.com",
      template: "author_notice",
      stream: "transactional",
    });
    expect(String(queue.sent[0]?.subject)).toContain("Book One");
    expect(await sendAuthorNotices(ctx(new Date()))).toBe(0);
    expect((await db.select().from(authorNotices))[0]?.sentAt).toBeTruthy();
  });

  it("sends the change digest from 17:00 with what others changed before then", async () => {
    const a = await verifiedAuthor("owner@example.com", "Digest Author");
    const bookId = await book(a, "Digest Book", "2027-01-01");
    await writeBookFields(db, bookId, [{ field: "summaryAi", value: "A new summary." }], { source: "ai" });
    expect(await sendChangeDigests(ctx(new Date("2099-01-01T16:00:00Z")))).toBe(0);
    expect(await sendChangeDigests(ctx(new Date("2099-01-01T17:05:00Z")))).toBe(1);
    expect(queue.sent[0]).toMatchObject({ template: "change_digest", to: "owner@example.com" });
    expect(String(queue.sent[0]?.text)).toContain("An editorial run changed the summary");
    expect((await db.select().from(changeNotifications))[0]?.emailedAt).toBeTruthy();
    expect(await sendChangeDigests(ctx(new Date("2099-01-01T17:20:00Z")))).toBe(0);
  });

  it("asks owners about releases 14 days out with a signed link, once; rollover marks them out", async () => {
    const a = await verifiedAuthor("owner@example.com", "Ask Author");
    const bookId = await book(a, "Soon Book", "2026-10-15");
    const now = new Date("2026-10-01T15:00:00Z");
    expect(await sendReleaseAsks(ctx(now))).toBe(1);
    const [ask] = await db.select().from(releaseAsks);
    expect(ask).toMatchObject({ stage: "t14", date: "2026-10-15", bookId });
    const url =
      /https:\/\/readlitrpg\.com\/dashboard\/release\/(\S+)/.exec(String(queue.sent[0]?.text))?.[1] ?? "";
    expect(await verifyLink(parseLinkKeys(KEYS), url, "release")).toEqual([ask?.id, a.userId]);
    expect(await sendReleaseAsks(ctx(new Date("2026-10-01T15:20:00Z")))).toBe(0);
    expect(await rollover(ctx(new Date("2026-10-15T12:00:00Z")))).toBe(1);
    expect((await db.select().from(releases))[0]?.status).toBe("released");
  });
});
