// Author jobs (DESIGN §7.7, §10.4, §13.4): prompt notices (a listing published, a claim decided),
// the daily note of changes others made, "Still on for Oct 12?" asks, and the release rollover.
// Author mail is transactional: it's about their own listings.

import {
  askRecipients,
  askUrl,
  createAsk,
  dueReleaseAsks,
  markNoticeSent,
  noticeRecipients,
  pendingNotices,
} from "@rlr/core/authors";
import { rolloverReleases } from "@rlr/core/catalog";
import { parseLinkKeys } from "@rlr/core/readers";
import { authorMembers, authors, books, changeNotifications, users } from "@rlr/core/schema";
import { formatDate, RELEASE_LABEL } from "@rlr/core/site";
import { type AuthorNotice, renderAuthorNotice, renderChangeDigest, renderReleaseAsk } from "@rlr/email";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { JobContext } from "./types";

const origin = (ctx: JobContext) => ctx.env.PUBLIC_ORIGIN.replace(/\/$/, "");

async function send(
  ctx: JobContext,
  to: { userId: string; email: string },
  template: "author_notice" | "change_digest" | "release_ask",
  email: { subject: string; html: string; text: string },
) {
  await ctx.env.Q_EMAIL.send({
    kind: "rendered",
    to: to.email,
    userId: to.userId,
    template,
    issueId: null,
    stream: "transactional",
    ...email,
  });
}

export async function sendAuthorNotices(ctx: JobContext): Promise<number> {
  const notices = await pendingNotices(ctx.db, 50);
  for (const n of notices) {
    const email = renderAuthorNotice(n.kind as AuthorNotice, {
      authorName: n.authorName,
      dashboardUrl: `${origin(ctx)}/dashboard`,
      payload: n.payload,
      origin: origin(ctx),
    });
    for (const r of await noticeRecipients(ctx.db, n)) await send(ctx, r, "author_notice", email);
    await markNoticeSent(ctx.db, n.id, ctx.now);
  }
  if (notices.length) ctx.log.info("author_notices.sent", { notices: notices.length });
  return notices.length;
}

const DIGEST_HOUR = 17;
const DIGEST_AUTHORS = 40;

/**
 * Once a day from 17:00 UTC: each profile's members get one email listing what others changed on
 * their books since the last one. Changes after 17:00 wait for tomorrow's.
 */
export async function sendChangeDigests(ctx: JobContext): Promise<number> {
  const { db, now } = ctx;
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_HOUR),
  ).toISOString();
  if (now.toISOString() < cutoff) return 0;
  const pending = await db
    .selectDistinct({ authorId: changeNotifications.authorId })
    .from(changeNotifications)
    .where(and(isNull(changeNotifications.emailedAt), lt(changeNotifications.createdAt, cutoff)))
    .orderBy(asc(changeNotifications.authorId))
    .limit(DIGEST_AUTHORS);
  for (const { authorId } of pending) {
    const rows = await db
      .select({
        id: changeNotifications.id,
        summary: changeNotifications.summary,
        title: books.title,
        bookId: books.id,
      })
      .from(changeNotifications)
      .innerJoin(books, eq(books.id, changeNotifications.bookId))
      .where(
        and(
          eq(changeNotifications.authorId, authorId),
          isNull(changeNotifications.emailedAt),
          lt(changeNotifications.createdAt, cutoff),
        ),
      )
      .limit(200);
    const [author] = await db.select({ name: authors.name }).from(authors).where(eq(authors.id, authorId));
    const members = await db
      .select({ userId: users.id, email: users.email })
      .from(authorMembers)
      .innerJoin(users, eq(users.id, authorMembers.userId))
      .where(and(eq(authorMembers.authorId, authorId), eq(users.state, "active")));
    if (rows.length && members.length && author) {
      const email = renderChangeDigest({
        authorName: author.name,
        dashboardUrl: `${origin(ctx)}/dashboard`,
        changes: rows.map((r) => ({
          bookTitle: r.title,
          bookUrl: `${origin(ctx)}/dashboard/books/${r.bookId}`,
          summary: r.summary,
        })),
      });
      for (const m of members) await send(ctx, m, "change_digest", email);
    }
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 90)
      await db
        .update(changeNotifications)
        .set({ emailedAt: now.toISOString() })
        .where(inArray(changeNotifications.id, ids.slice(i, i + 90)));
  }
  if (pending.length) ctx.log.info("change_digest.sent", { authors: pending.length });
  return pending.length;
}

/** "Still on for Oct 12?" 14 and 3 days out (§7.7). Each ask is recorded once, then emailed. */
export async function sendReleaseAsks(ctx: JobContext): Promise<number> {
  const keys = parseLinkKeys(ctx.env.LINK_SIGNING_KEYS);
  let sent = 0;
  for (const due of (await dueReleaseAsks(ctx.db, ctx.now)).slice(0, 100)) {
    const askId = await createAsk(ctx.db, due, ctx.now);
    if (!askId) continue;
    const recipients = await askRecipients(ctx.db, due.bookId);
    const emails = recipients.length
      ? await ctx.db
          .select({ userId: users.id, email: users.email })
          .from(users)
          .where(
            and(inArray(users.id, [...new Set(recipients.map((r) => r.userId))]), eq(users.state, "active")),
          )
      : [];
    for (const r of emails) {
      const email = renderReleaseAsk({
        title: due.title,
        kind: (RELEASE_LABEL[due.kind] ?? due.kind).toLowerCase(),
        date: formatDate(due.date, "day"),
        url: await askUrl(keys, origin(ctx), askId, r.userId, ctx.now.getTime()),
      });
      await send(ctx, r, "release_ask", email);
      sent++;
    }
  }
  if (sent) ctx.log.info("release_asks.sent", { sent });
  return sent;
}

export async function rollover(ctx: JobContext): Promise<number> {
  return rolloverReleases(ctx.db, ctx.now);
}
