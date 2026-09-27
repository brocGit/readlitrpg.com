import { addConfirmation, ingestBook, setVisibility } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import { emailConsents, newsletterIssues, posts, users } from "@rlr/core/schema";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1, TestKV } from "@rlr/core/testing";
import { emailJobSchema } from "@rlr/email";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { dailyRoundup, dailySend } from "../src/jobs/news";
import type { JobContext } from "../src/jobs/types";

class FakeQueue {
  readonly sent: Record<string, unknown>[] = [];
  async send(body: Record<string, unknown>) {
    this.sent.push(body);
  }
}

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
let db: Db;
let email: FakeQueue;
let jobs: FakeQueue;
let kv: TestKV;
let calls: { url: string; body: string | null }[];
const now = new Date();
const today = now.toISOString().slice(0, 10);

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
  if (url.endsWith("createSession"))
    return new Response(JSON.stringify({ accessJwt: "jwt", did: "did:plc:rlr" }), { status: 200 });
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const ctx = (extra: Record<string, string> = {}): JobContext =>
  ({
    db,
    log,
    now,
    fetch: fakeFetch,
    env: {
      CONFIG: kv.asKV(),
      Q_EMAIL: email,
      Q_JOBS: jobs,
      ENVIRONMENT: "local",
      PUBLIC_ORIGIN: "https://readlitrpg.com",
      PUBLIC_MEDIA_ORIGIN: "https://media.readlitrpg.com",
      LINK_SIGNING_KEYS: '{"k1":"test-link-key-that-is-at-least-32-chars"}',
      ...extra,
    },
  }) as unknown as JobContext;

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  email = new FakeQueue();
  jobs = new FakeQueue();
  kv = new TestKV();
  calls = [];
  await syncTaxonomy(db);
});

async function book(title: string, kind: "ebook" | "audio", date: string) {
  const { bookId } = await ingestBook(
    db,
    { title, authors: [{ name: "Ann Writer" }], primaryGenre: "litrpg", releases: [{ kind, date }] },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
}

describe("news jobs", () => {
  it("publishes Today in LitRPG once, posts it to Bluesky and Mastodon when set up, and emails daily readers", async () => {
    await book("Out Today", "ebook", today);
    await book("Heard Today", "audio", today);
    const social = {
      BLUESKY_HANDLE: "readlitrpg.com",
      BLUESKY_APP_PASSWORD: "app-pass",
      MASTODON_URL: "https://mastodon.example",
      MASTODON_TOKEN: "tok",
    };
    expect(await dailyRoundup(ctx(social))).toBe(1);
    const [post] = await db
      .select()
      .from(posts)
      .where(eq(posts.genKey, `daily:${today}`));
    expect(post?.status).toBe("published");
    expect(jobs.sent).toEqual([expect.objectContaining({ job: "og.render" })]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/xrpc/com.atproto.server.createSession",
      "/xrpc/com.atproto.repo.createRecord",
      "/api/v1/statuses",
    ]);
    expect(calls[1]?.body).toContain(`/news/${today.replaceAll("-", "/")}`);
    // A retried job doesn't post twice.
    expect(await dailyRoundup(ctx(social))).toBe(0);
    expect(calls).toHaveLength(3);

    await db.insert(users).values([
      { id: "u1", email: "daily@example.com", state: "active", emailVerified: true },
      { id: "u2", email: "weekly@example.com", state: "active", emailVerified: true },
    ]);
    await db.insert(emailConsents).values([
      { id: "c1", userId: "u1", list: "daily_digest", status: "active", source: "daily" },
      { id: "c2", userId: "u2", list: "weekly_digest", status: "active", source: "newsletter" },
    ]);
    expect(await dailySend(ctx())).toBe(1);
    expect(email.sent).toHaveLength(1);
    const sent = emailJobSchema.parse(email.sent[0]);
    expect(sent).toMatchObject({
      kind: "rendered",
      to: "daily@example.com",
      template: "daily_digest",
      stream: "marketing",
    });
    if (sent.kind === "rendered") {
      expect(sent.subject).toBe(post?.title);
      expect(sent.text).toContain("Out Today");
      expect(sent.text).toContain("Unsubscribe: https://readlitrpg.com/u/");
    }
    const [issue] = await db.select().from(newsletterIssues).where(eq(newsletterIssues.kind, "daily"));
    expect(issue?.status).toBe("sent");
    expect(await dailySend(ctx())).toBe(0);
  });
});
