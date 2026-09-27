// The owner's notifications (DESIGN §8.4). owner.daily_digest emails at 13:00 UTC only when an
// item is due within 48 hours or something urgent is open; owner.weekly_summary sends Sunday's
// numbers; owner.alerts tells the owner at once (email, and a private Discord webhook if set) about
// security events, disputes, circuit breakers and anything at owner.alert_min_priority or above.

import { countdown, type InboxItem } from "@rlr/core/inbox";
import { SafeFetchError, safeFetch } from "@rlr/core/net";
import { dailyActions, markAlerted, ownerEmails, pendingAlerts, weeklySummary } from "@rlr/core/owner";
import { emailConsents } from "@rlr/core/schema";
import { loadSettings, type Settings } from "@rlr/core/settings";
import { formatDate } from "@rlr/core/site";
import {
  type OwnerItem,
  type Rendered,
  renderOwnerAlert,
  renderOwnerDaily,
  renderOwnerWeekly,
} from "@rlr/email";
import { and, count, eq } from "drizzle-orm";
import type { JobContext } from "./types";

const adminOrigin = (env: Env) => (env.ADMIN_ORIGIN ?? "").replace(/\/$/, "");

async function settingsFor(ctx: JobContext): Promise<Settings> {
  return loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
}

/** Operational mail to the admins: transactional, never on the marketing stream. */
async function sendToOwners(
  ctx: JobContext,
  template: "owner_daily" | "owner_weekly" | "owner_alert",
  email: Rendered,
): Promise<number> {
  const to = await ownerEmails(ctx.db);
  if (!to.length) ctx.log.warn("owner.no_admin_address", { template });
  for (const address of to)
    await ctx.env.Q_EMAIL.send({
      kind: "rendered",
      to: address,
      userId: null,
      template,
      issueId: null,
      stream: "transactional",
      ...email,
    });
  return to.length;
}

const ownerItem = (i: InboxItem, now: Date): OwnerItem => ({
  title: i.title,
  type: i.type,
  when: i.dueAt ? `due ${formatDate(i.dueAt.slice(0, 10), "day")}` : countdown(i, now),
});

export async function ownerDailyDigest(ctx: JobContext): Promise<number> {
  const settings = await settingsFor(ctx);
  if (!settings["owner.daily_digest"]) return 0;
  const actions = await dailyActions(ctx.db, ctx.now);
  // Only when needed: a quiet day sends nothing (§8.4).
  if (!actions) return 0;
  const email = renderOwnerDaily({
    due: actions.due.map((i) => ownerItem(i, ctx.now)),
    urgent: actions.urgent.map((i) => ({ ...ownerItem(i, ctx.now), when: `priority ${i.priority}` })),
    open: actions.open,
    inboxUrl: `${adminOrigin(ctx.env)}/inbox`,
  });
  await sendToOwners(ctx, "owner_daily", email);
  return actions.due.length + actions.urgent.length;
}

export async function ownerWeeklySummary(ctx: JobContext): Promise<number> {
  const settings = await settingsFor(ctx);
  if (!settings["owner.weekly_summary"]) return 0;
  const s = await weeklySummary(ctx.db, ctx.now);
  const origin = adminOrigin(ctx.env);
  const [weekly] = await ctx.db
    .select({ n: count() })
    .from(emailConsents)
    .where(and(eq(emailConsents.list, "weekly_digest"), eq(emailConsents.status, "active")));
  const [daily] = await ctx.db
    .select({ n: count() })
    .from(emailConsents)
    .where(and(eq(emailConsents.list, "daily_digest"), eq(emailConsents.status, "active")));
  const friday = new Date(ctx.now.getTime() + ((5 - ctx.now.getUTCDay() + 7) % 7) * 86_400_000);
  const lineup = [
    `Patch Notes: ${formatDate(friday.toISOString().slice(0, 10), "day")}, from 13:00 UTC, to ${weekly?.n ?? 0} readers${settings["flags.newsletter_send"] ? "" : " (sending is paused)"}`,
    `Patch Notes Daily: every morning to ${daily?.n ?? 0} readers`,
  ];
  const email = renderOwnerWeekly({
    ...s,
    lineup,
    autoApproved: s.autoApproved.map((x) => ({
      title: x.title,
      status: x.status,
      undoUrl: x.undoable ? `${origin}/audit?id=${x.auditId}` : null,
    })),
    scheduledPosts: s.scheduledPosts.map((x) => ({
      title: x.title,
      when: x.publishAt
        ? `${formatDate(x.publishAt.slice(0, 10), "day")} ${x.publishAt.slice(11, 16)} UTC`
        : "",
    })),
    bookedAds: s.bookedAds.map((x) => ({
      campaign: x.campaign,
      slot: x.slot,
      when: formatDate(x.periodStart, "day"),
    })),
    inboxUrl: `${origin}/inbox`,
    auditUrl: `${origin}/audit?undoable=1`,
  });
  await sendToOwners(ctx, "owner_weekly", email);
  return 1;
}

/** A private Discord channel (optional). The webhook URL is a secret: never logged. */
async function discord(ctx: JobContext, item: InboxItem, url: string): Promise<void> {
  const content = `**${item.type}** (priority ${item.priority}): ${item.title}\n${adminOrigin(ctx.env)}/inbox`;
  try {
    const res = await safeFetch(url, {
      allowHosts: ["discord.com", "discordapp.com"],
      method: "POST",
      fetch: ctx.fetch,
      headers: { "content-type": "application/json" },
      // No @everyone or role pings from item titles.
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      timeoutMs: 10_000,
    });
    if (res.status >= 300) ctx.log.warn("owner.discord_failed", { status: res.status });
  } catch (error) {
    ctx.log.warn("owner.discord_failed", {
      reason: error instanceof SafeFetchError ? error.code : "error",
    });
  }
}

export async function ownerAlerts(ctx: JobContext): Promise<number> {
  const settings = await settingsFor(ctx);
  const items = await pendingAlerts(ctx.db, settings["owner.alert_min_priority"], ctx.now);
  if (!items.length) return 0;
  const url = `${adminOrigin(ctx.env)}/inbox`;
  for (const item of items) {
    await sendToOwners(
      ctx,
      "owner_alert",
      renderOwnerAlert({
        title: item.title,
        type: item.type,
        priority: item.priority,
        summary: item.aiSummary,
        url,
      }),
    );
    if (ctx.env.DISCORD_ALERT_WEBHOOK) await discord(ctx, item, ctx.env.DISCORD_ALERT_WEBHOOK);
  }
  // Marked after sending: a crash in between re-sends rather than stays silent.
  await markAlerted(
    ctx.db,
    items.map((i) => i.id),
    ctx.now,
  );
  return items.length;
}
