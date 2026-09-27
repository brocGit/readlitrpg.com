import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "../src/audit";
import { addConfirmation, ingestBook, setVisibility, writeBookFields } from "../src/catalog";
import { CONTENT_INBOX_HANDLERS, createPost, getPost } from "../src/content";
import { createDb, type Db } from "../src/db";
import { auditLog, authors, bookFieldSources, books, inboxItems, posts } from "../src/db/schema";
import {
  countdown,
  isLowRisk,
  listOpenInbox,
  openInboxItem,
  runInboxDefaults,
  snoozeInboxItem,
  trustAuthor,
  wakeSnoozed,
} from "../src/inbox";
import { dailyActions, markAlerted, pendingAlerts, weeklySummary } from "../src/owner";
import { defaultSettings, loadSettings, updateSetting } from "../src/settings";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1, TestKV } from "../src/testing";
import { listAudit, UndoError, undoAudit } from "../src/undo";

let db: Db;
const env = { origin: "https://readlitrpg.com", mediaOrigin: "https://media.readlitrpg.com" };
const owner = { type: "admin" as const, id: "owner1" };
// Rows get the real clock's timestamps (audit, inbox), so the test's clock is the real one too.
const now = new Date();
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

async function reviewItem(title: string, extra: Partial<Parameters<typeof openInboxItem>[1]> = {}) {
  const post = await createPost(db, { type: "roundup", title, bodyMd: "Books out this week." }, env);
  await db.update(posts).set({ status: "in_review" }).where(eq(posts.id, post.id));
  const item = await openInboxItem(db, {
    type: "post_review",
    title,
    subjectType: "post",
    subjectId: post.id,
    payload: { postId: post.id },
    defaultAction: "approve",
    defaultActionAt: hours(24),
    ...extra,
  });
  if (!item) throw new Error("item");
  return { post, item };
}

describe("snooze and default actions", () => {
  it("hides a snoozed item until its time, but still runs its default on time, audited with an undo", async () => {
    const { post, item } = await reviewItem("Week of 5 Oct");
    expect(await snoozeInboxItem(db, item.id, new Date(hours(48)), now)).toBe(true);
    expect(await listOpenInbox(db)).toHaveLength(0);
    expect(await listOpenInbox(db, 100, { snoozed: true })).toHaveLength(1);
    expect(await wakeSnoozed(db, new Date(hours(1)))).toBe(0);

    // The default fires at 24 h even though the owner snoozed it to 48 h.
    const closed = await runInboxDefaults(db, new Date(hours(25)), {
      handlers: CONTENT_INBOX_HANDLERS,
      settings: defaultSettings(),
      renderEnv: env,
    });
    expect(closed).toBe(1);
    expect((await getPost(db, post.id))?.status).toBe("published");

    const [row] = await listAudit(db, { action: "inbox.default_action" }, new Date(hours(26)));
    expect(row?.undo).toEqual({ kind: "post_status", postId: post.id, to: "in_review" });
    expect(row?.undoState).toBe("open");
    expect(row?.actorType).toBe("system");

    await undoAudit(db, row?.id ?? "", owner, {}, new Date(hours(26)));
    expect((await getPost(db, post.id))?.status).toBe("in_review");
    await expect(undoAudit(db, row?.id ?? "", owner, {}, new Date(hours(27)))).rejects.toThrow(
      "already undone",
    );
    expect((await listAudit(db, { undoable: true }, new Date(hours(27)))).map((r) => r.action)).toEqual([]);
    // Thirty days on, it can't be undone at all.
    await expect(
      undoAudit(db, row?.id ?? "", owner, {}, new Date(now.getTime() + 40 * 86_400_000)),
    ).rejects.toThrow(UndoError);
  });

  it("wakes items whose snooze is over", async () => {
    const item = await openInboxItem(db, { type: "author_report", title: "Wrong date" });
    await snoozeInboxItem(db, item?.id ?? "", new Date(hours(4)), now);
    expect(await wakeSnoozed(db, new Date(hours(5)))).toBe(1);
    expect((await listOpenInbox(db)).map((i) => i.title)).toEqual(["Wrong date"]);
  });
});

describe("low-risk, countdowns and trust", () => {
  it("picks only items that would approve themselves, unflagged and not urgent", async () => {
    const { item: safe } = await reviewItem("Safe");
    const { item: flagged } = await reviewItem("Flagged");
    await db.update(inboxItems).set({ riskScore: 70 }).where(eq(inboxItems.id, flagged.id));
    const dup = await openInboxItem(db, {
      type: "possible_duplicate",
      title: "Dup",
      defaultAction: "approve",
      defaultActionAt: hours(1),
    });
    const items = await listOpenInbox(db);
    const low = items.filter((i) => isLowRisk(i, CONTENT_INBOX_HANDLERS, 30)).map((i) => i.id);
    expect(low).toEqual([safe.id]);
    expect(dup && isLowRisk(dup, CONTENT_INBOX_HANDLERS, 30)).toBe(false);
    expect(countdown(safe, now)).toBe("Auto-approves in 1 d 0 h");
    expect(countdown({ ...safe, defaultAction: "none" }, now)).toBe("Waits for you");
  });

  it("raises an author one step, to T1 at most", async () => {
    await db
      .insert(authors)
      .values({ id: "a1", name: "Ann", slug: "ann", nameKey: "ann", trustLevel: "T0", origin: "admin" });
    expect(await trustAuthor(db, "a1", now)).toEqual({ from: "T0", to: "T1" });
    expect(await trustAuthor(db, "a1", now)).toBeNull();
    expect((await db.select().from(authors))[0]?.trustLevel).toBe("T1");
  });
});

describe("undo", () => {
  it("removes the owner's override and lets precedence pick the value again", async () => {
    const { bookId } = await ingestBook(
      db,
      { title: "Iron Tower", authors: [{ name: "Ann" }], primaryGenre: "litrpg" },
      { source: "api", origin: "import", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    await writeBookFields(db, bookId, [{ field: "pageCount", value: 300 }], { source: "api" });
    await writeBookFields(db, bookId, [{ field: "pageCount", value: 999 }], { source: "admin" });
    const [src] = await db
      .select({ id: bookFieldSources.id })
      .from(bookFieldSources)
      .where(eq(bookFieldSources.source, "admin"));
    const row = await appendAudit(db, {
      actor: owner,
      action: "catalog.field_override",
      subjectType: "book",
      subjectId: bookId,
      diff: { field: "pageCount", value: 999, undo: { kind: "field_source", bookId, sourceId: src?.id } },
    });
    expect((await db.select().from(books))[0]?.pageCount).toBe(999);
    await undoAudit(db, row.id, owner);
    expect((await db.select().from(books))[0]?.pageCount).toBe(300);
  });

  it("puts a setting back, and unpublishes a listing", async () => {
    const kv = new TestKV().asKV();
    await updateSetting({ db, kv, actor: owner }, "inbox.low_risk_max", 60);
    const [row] = await listAudit(db, { action: "settings.update" });
    await undoAudit(db, row?.id ?? "", owner, { settings: { kv } });
    expect((await loadSettings({ db, kv }))["inbox.low_risk_max"]).toBe(30);

    const { bookId } = await ingestBook(
      db,
      { title: "Deep Delve", authors: [{ name: "Cid" }], primaryGenre: "litrpg" },
      { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
    await setVisibility(db, bookId, "published");
    const pub = await appendAudit(db, {
      actor: owner,
      action: "catalog.book_published",
      subjectType: "book",
      subjectId: bookId,
      diff: { undo: { kind: "visibility", bookId, to: "draft" } },
    });
    await undoAudit(db, pub.id, owner);
    expect((await db.select().from(books).where(eq(books.id, bookId)))[0]?.visibility).toBe("draft");
    const undone = await db.select().from(auditLog).where(eq(auditLog.action, "audit.undo"));
    expect(undone.map((u) => u.subjectId)).toContain(pub.id);
  });

  it("refuses rows without an undo", async () => {
    const row = await appendAudit(db, { actor: owner, action: "catalog.owner_check" });
    await expect(undoAudit(db, row.id, owner)).rejects.toThrow("can't be undone");
  });
});

describe("owner notifications", () => {
  it("emails daily only when something is due or urgent, and alerts once", async () => {
    expect(await dailyActions(db, now)).toBeNull();
    await reviewItem("Due soon");
    await openInboxItem(db, { type: "note", title: "Later", dueAt: hours(24 * 5) });
    const urgent = await openInboxItem(db, {
      type: "security_event",
      title: "New admin device",
      priority: 60,
    });
    const daily = await dailyActions(db, now);
    expect(daily?.due.map((i) => i.title)).toEqual(["Due soon"]);
    expect(daily?.open).toBe(3);

    // Security events alert whatever their priority; the rest need owner.alert_min_priority.
    const alerts = await pendingAlerts(db, 90, now);
    expect(alerts.map((a) => a.title)).toEqual(["New admin device"]);
    await markAlerted(db, [urgent?.id ?? ""], now);
    expect(await pendingAlerts(db, 90, now)).toEqual([]);
  });

  it("summarizes the week with what decided itself", async () => {
    await reviewItem("Roundup");
    await runInboxDefaults(db, new Date(hours(25)), {
      handlers: CONTENT_INBOX_HANDLERS,
      settings: defaultSettings(),
      renderEnv: env,
    });
    const s = await weeklySummary(db, new Date(hours(30)));
    expect(s.autoApproved).toMatchObject([{ title: "Roundup", status: "auto_approved", undoable: true }]);
    expect(s.inbox).toMatchObject({ autoDecided: 1, ownerDecided: 0, automationRate: 100 });
    expect(s.kpis.map((k) => k.layer)).toEqual(["Search", "Onboarding", "Patch Notes", "Catalog", "Money"]);
  });
});
