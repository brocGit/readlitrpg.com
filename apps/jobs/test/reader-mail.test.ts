import { addConfirmation, ingestBook, setRelease, setVisibility, writeAiScores } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import { buildMatrix, resetMatrixCache, storeMatrix } from "@rlr/core/match";
import {
  confirmSubscription,
  parseLinkKeys,
  requestExport,
  requestSubscription,
  saveQuery,
  setConsent,
  setFollow,
  startSequence,
  unsubscribe,
  verifyLink,
} from "@rlr/core/readers";
import {
  dataExports,
  emailSends,
  emailSequences,
  inboxItems,
  newsletterIssues,
  savedQueries,
} from "@rlr/core/schema";
import { updateSetting } from "@rlr/core/settings";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1, TestKV, TestR2 } from "@rlr/core/testing";
import { emailJobSchema } from "@rlr/email";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { sendReleaseAlerts } from "../src/jobs/alerts";
import { buildDigestIssue, isoWeek, sendDigestChunk } from "../src/jobs/digest";
import { buildExports } from "../src/jobs/readers";
import { purgeExpired } from "../src/jobs/retention";
import type { JobContext } from "../src/jobs/types";
import { sendWelcomeSteps } from "../src/jobs/welcome";

class FakeQueue {
  readonly sent: Record<string, unknown>[] = [];
  async send(body: Record<string, unknown>) {
    // Every message must be one the email consumer accepts.
    expect(emailJobSchema.safeParse(body).success).toBe(true);
    this.sent.push(body);
  }
}

const KEYS = '{"k1":"test-link-key-that-is-at-least-32-chars"}';
const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
let db: Db;
let queue: FakeQueue;
let kv: TestKV;
let priv: TestR2;

function ctx(now: Date, env: Record<string, unknown> = {}): JobContext {
  return {
    db,
    log,
    now,
    env: {
      CONFIG: kv.asKV(),
      Q_EMAIL: queue,
      PRIVATE: priv,
      PUBLIC_ORIGIN: "https://readlitrpg.com",
      LINK_SIGNING_KEYS: KEYS,
      ENVIRONMENT: "local",
      ...env,
    } as unknown as Env,
  };
}

async function published(
  title: string,
  author: string,
  dials: Record<string, number>,
  tags: string[],
  series?: string,
) {
  const { bookId } = await ingestBook(
    db,
    {
      title,
      authors: [{ name: author }],
      primaryGenre: "litrpg",
      tags: tags.map((slug) => ({ slug })),
      confidence: 0.85,
      ...(series ? { series: { name: series, position: 1 } } : {}),
    },
    { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await writeAiScores(
    db,
    bookId,
    Object.entries(dials).map(([key, value]) => ({ key, value, confidence: 0.85 })),
    5,
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  return bookId;
}

async function reader(email: string, lists: ("weekly_digest" | "reading_list")[]) {
  const r = await requestSubscription(db, { email, lists, source: "newsletter" });
  if (r.status !== "confirm") throw new Error("expected a confirmation");
  const c = await confirmSubscription(db, r.token);
  if (!c) throw new Error("confirmation failed");
  return c.userId;
}

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  queue = new FakeQueue();
  kv = new TestKV();
  priv = new TestR2();
  resetMatrixCache();
  await syncTaxonomy(db);
});

describe("welcome sequence", () => {
  it("sends the reading list with signed one-click links, then waits for day 2", async () => {
    await published("Crunch Tower", "Ann", { crunch: 9, pacing: 7 }, ["tower-climbing", "build-crafting"]);
    await published("Soft Farm", "Cid", { crunch: 1, pacing: 2 }, ["farming", "cozy"]);
    await storeMatrix(kv.asKV(), await buildMatrix(db));
    const start = new Date("2026-10-01T10:00:00Z");
    const userId = await reader("a@example.com", ["reading_list", "weekly_digest"]);
    await startSequence(db, userId, "welcome", { source: "newsletter" }, start);

    expect(await sendWelcomeSteps(ctx(start))).toBe(1);
    const e1 = queue.sent[0] as {
      template: string;
      stream: string;
      html: string;
      headers: Record<string, string>;
    };
    expect(e1).toMatchObject({ template: "welcome_1", stream: "marketing", to: "a@example.com" });
    const unsub = /\/u\/([^>]+)>/.exec(e1.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect(await verifyLink(parseLinkKeys(KEYS), unsub, "unsub")).toEqual([userId, "reading_list"]);
    expect(e1.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(e1.html).toContain("/m/");
    expect(e1.html).toMatch(/Crunch Tower|Soft Farm/);

    expect(await sendWelcomeSteps(ctx(new Date("2026-10-02T10:00:00Z")))).toBe(0);
    expect(await sendWelcomeSteps(ctx(new Date("2026-10-03T10:05:00Z")))).toBe(1);
    expect(queue.sent[1]).toMatchObject({ template: "welcome_2" });
  });

  it("ends the sequence for a reader who unsubscribed, and 'just the list' gets E1 only", async () => {
    const now = new Date("2026-10-01T10:00:00Z");
    const gone = await reader("gone@example.com", ["reading_list"]);
    await startSequence(db, gone, "welcome", {}, now);
    await unsubscribe(db, gone, "all");
    const listOnly = await reader("list@example.com", ["reading_list"]);
    await startSequence(db, listOnly, "list_only", {}, now);
    expect(await sendWelcomeSteps(ctx(now))).toBe(1);
    expect(queue.sent.map((m) => m.to)).toEqual(["list@example.com"]);
    const rows = await db.select().from(emailSequences);
    expect(rows.every((r) => r.doneAt)).toBe(true);
  });

  it("waits, with one inbox item, until production has a postal address", async () => {
    const now = new Date("2026-10-01T10:00:00Z");
    const userId = await reader("a@example.com", ["reading_list"]);
    await startSequence(db, userId, "list_only", {}, now);
    expect(await sendWelcomeSteps(ctx(now, { ENVIRONMENT: "production" }))).toBe(0);
    expect(await sendWelcomeSteps(ctx(now, { ENVIRONMENT: "production" }))).toBe(0);
    expect((await db.select().from(inboxItems)).map((i) => i.dedupeKey)).toEqual([
      "email.postal_address_missing",
    ]);
    await updateSetting(
      { db, kv: kv.asKV(), actor: { type: "system", id: "test" } },
      "email.postal_address",
      "ReadLitRPG, PO Box 1, Springfield",
    );
    expect(await sendWelcomeSteps(ctx(now, { ENVIRONMENT: "production" }))).toBe(1);
    expect(queue.sent[0]?.text).toContain("PO Box 1");
  });
});

describe("release-day alerts", () => {
  it("bundles today's releases from instant follows into one email, once a day", async () => {
    const now = new Date("2026-10-05T11:00:00Z");
    const bookId = await published("Tower Two", "Ann", { crunch: 8 }, ["tower-climbing"], "Tower Saga");
    await setRelease(
      db,
      bookId,
      { kind: "ebook", date: "2026-10-05" },
      "admin",
      new Date("2026-09-01T00:00:00Z"),
    );
    const userId = await reader("fan@example.com", ["weekly_digest"]);
    await setFollow(db, userId, "series", "tower-saga", "instant");
    await setConsent(db, userId, "release_alerts", true, "follow");
    const quiet = await reader("quiet@example.com", ["weekly_digest"]);
    await setConsent(db, quiet, "release_alerts", true, "follow");

    expect(await sendReleaseAlerts(ctx(now))).toBe(1);
    expect(queue.sent[0]).toMatchObject({
      template: "release_alert",
      to: "fan@example.com",
      subject: "Out today: Tower Two",
    });
    expect(await sendReleaseAlerts(ctx(new Date("2026-10-05T11:10:00Z")))).toBe(0);
    expect(queue.sent).toHaveLength(1);
  });
});

describe("saved search alerts", () => {
  it("sends new books that fit a saved search set to instant, then moves its mark forward", async () => {
    await published("Old Farm", "Cid", { crunch: 1 }, ["farming"]);
    await published("New Tower", "Ann", { crunch: 9 }, ["tower-climbing"]);
    await storeMatrix(kv.asKV(), await buildMatrix(db));
    const userId = await reader("searcher@example.com", ["weekly_digest"]);
    await setConsent(db, userId, "release_alerts", true, "saved_search");
    const id = await saveQuery(db, userId, {
      kind: "find",
      name: "Towers",
      params: "inc=tower-climbing",
      alert: "instant",
    });
    await db
      .update(savedQueries)
      .set({ lastAlertedAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(savedQueries.id, id));

    expect(await sendReleaseAlerts(ctx(new Date()))).toBe(1);
    expect(queue.sent[0]?.subject).toBe("New for you: New Tower");
    expect(String(queue.sent[0]?.text)).toContain('NEW FOR "Towers"');
    expect(String(queue.sent[0]?.text)).not.toContain("Old Farm");
    const [saved] = await db.select().from(savedQueries);
    expect(saved?.lastAlertedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });
});

describe("Patch Notes", () => {
  it("freezes on Thursday, sends from Friday 13:00 to weekly readers only", async () => {
    await published("Fresh Crunch", "Ann", { crunch: 9 }, ["build-crafting"]);
    await storeMatrix(kv.asKV(), await buildMatrix(db));
    const thursday = new Date("2026-10-01T09:00:00Z");
    expect(isoWeek(thursday)).toBe("2026-W40");
    expect(await buildDigestIssue(ctx(thursday))).toBe(1);
    expect(await buildDigestIssue(ctx(thursday))).toBe(0);
    await reader("weekly@example.com", ["weekly_digest"]);
    await reader("listonly@example.com", ["reading_list"]);

    expect(await sendDigestChunk(ctx(new Date("2026-10-02T12:55:00Z")))).toBe(0);
    expect(await sendDigestChunk(ctx(new Date("2026-10-02T13:05:00Z")))).toBe(1);
    expect(queue.sent.map((m) => [m.to, m.template])).toEqual([["weekly@example.com", "weekly_digest"]]);
    const [issue] = await db.select().from(newsletterIssues);
    expect(issue?.status).toBe("sent");
    expect(String(queue.sent[0]?.subject)).toContain("Patch Notes 2 Oct 2026");
    expect(await sendDigestChunk(ctx(new Date("2026-10-02T13:10:00Z")))).toBe(0);
  });

  it("pauses the issue when complaints cross the limit", async () => {
    const thursday = new Date("2026-10-01T09:00:00Z");
    await buildDigestIssue(ctx(thursday));
    const [issue] = await db.select().from(newsletterIssues);
    await reader("weekly@example.com", ["weekly_digest"]);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      template: "weekly_digest",
      issueId: issue?.id ?? "",
      status: i < 2 ? ("complained" as const) : ("delivered" as const),
    }));
    for (let i = 0; i < rows.length; i += 20) await db.insert(emailSends).values(rows.slice(i, i + 20));
    await db.update(newsletterIssues).set({ status: "sending" });
    expect(await sendDigestChunk(ctx(new Date("2026-10-02T13:05:00Z")))).toBe(0);
    expect((await db.select().from(newsletterIssues))[0]?.status).toBe("paused");
    expect((await db.select().from(inboxItems))[0]?.title).toContain("paused");
  });
});

describe("exports and retention", () => {
  it("writes the export privately, emails a link, and deletes it after it expires", async () => {
    const userId = await reader("me@example.com", ["weekly_digest"]);
    await requestExport(db, userId);
    const now = new Date("2026-10-01T10:00:00Z");
    expect(await buildExports(ctx(now))).toBe(1);
    const [row] = await db.select().from(dataExports);
    expect(row?.status).toBe("ready");
    expect(priv.objects.has(row?.objectKey ?? "")).toBe(true);
    const file = await priv.get(row?.objectKey ?? "");
    expect(JSON.parse((await file?.text()) ?? "{}").account.email).toBe("me@example.com");
    expect(queue.sent[0]).toMatchObject({ template: "export_ready", stream: "transactional" });
    expect(String(queue.sent[0]?.text)).toContain(`/account/export/${row?.id}`);

    await db.insert(emailSends).values({
      id: "old",
      template: "weekly_digest",
      status: "sent",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await purgeExpired(ctx(new Date("2026-10-09T10:00:00Z")));
    expect(priv.objects.size).toBe(0);
    expect((await db.select().from(dataExports))[0]?.status).toBe("expired");
    expect(await db.select().from(emailSends).where(eq(emailSends.id, "old"))).toEqual([]);
  });
});
