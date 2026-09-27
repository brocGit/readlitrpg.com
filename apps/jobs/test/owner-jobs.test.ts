import { createDb, type Db } from "@rlr/core/db";
import { openInboxItem } from "@rlr/core/inbox";
import { inboxItems, users } from "@rlr/core/schema";
import { createTestD1, TestKV } from "@rlr/core/testing";
import { emailJobSchema } from "@rlr/email";
import { beforeEach, describe, expect, it } from "vitest";
import { ownerAlerts, ownerDailyDigest, ownerWeeklySummary } from "../src/jobs/owner";
import type { JobContext } from "../src/jobs/types";

class FakeQueue {
  readonly sent: Record<string, unknown>[] = [];
  async send(body: Record<string, unknown>) {
    expect(emailJobSchema.safeParse(body).success).toBe(true);
    this.sent.push(body);
  }
}

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
let db: Db;
let email: FakeQueue;
let calls: { url: string; body: string }[];
const now = new Date();

const ctx = (extra: Record<string, string> = {}): JobContext =>
  ({
    db,
    log,
    now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    env: {
      CONFIG: new TestKV().asKV(),
      Q_EMAIL: email,
      ENVIRONMENT: "local",
      ADMIN_ORIGIN: "https://admin.readlitrpg.com",
      ...extra,
    },
  }) as unknown as JobContext;

beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  email = new FakeQueue();
  calls = [];
  await db.insert(users).values([
    { id: "u1", email: "owner@example.com", emailVerified: true, isAdmin: true },
    { id: "u2", email: "reader@example.com", emailVerified: true },
  ]);
});

describe("owner notifications", () => {
  it("sends the daily email only when something is due, to admins only", async () => {
    expect(await ownerDailyDigest(ctx())).toBe(0);
    expect(email.sent).toEqual([]);
    await openInboxItem(db, {
      type: "post_review",
      title: "Week of 5 Oct",
      defaultAction: "approve",
      defaultActionAt: new Date(now.getTime() + 5 * 3_600_000).toISOString(),
    });
    expect(await ownerDailyDigest(ctx())).toBe(1);
    expect(email.sent.map((m) => [m.to, m.template, m.stream])).toEqual([
      ["owner@example.com", "owner_daily", "transactional"],
    ]);
    expect(String(email.sent[0]?.text)).toContain("Week of 5 Oct (post_review · Auto-approves in 5 h)");
    expect(String(email.sent[0]?.text)).toContain("https://admin.readlitrpg.com/inbox");
  });

  it("alerts once, by email and to Discord without pings", async () => {
    await openInboxItem(db, { type: "security_event", title: "New admin device @everyone", priority: 60 });
    await openInboxItem(db, { type: "note", title: "Routine", priority: 40 });
    const webhook = "https://discord.com/api/webhooks/1/secret";
    expect(await ownerAlerts(ctx({ DISCORD_ALERT_WEBHOOK: webhook }))).toBe(1);
    expect(email.sent.map((m) => m.subject)).toEqual(["Alert: New admin device @everyone"]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").allowed_mentions).toEqual({ parse: [] });
    expect(await ownerAlerts(ctx({ DISCORD_ALERT_WEBHOOK: webhook }))).toBe(0);
    expect((await db.select().from(inboxItems)).filter((i) => i.alertedAt)).toHaveLength(1);
  });

  it("sends the Sunday summary", async () => {
    expect(await ownerWeeklySummary(ctx())).toBe(1);
    const text = String(email.sent[0]?.text);
    expect(email.sent[0]?.template).toBe("owner_weekly");
    expect(text).toContain("Patch Notes: 0 weekly subscribers");
    expect(text).toContain("NEXT WEEK'S NEWSLETTERS");
  });
});
