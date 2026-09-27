// Patch Notes, the weekly digest (DESIGN §13.5). Thursday freezes the issue: this week's new books,
// the quiz of the week. From Friday 13:00 UTC each run builds the next chunk of readers from their
// own profile, follows and saved searches, and queues their email. A circuit breaker pauses the
// issue if bounces or complaints climb; a daily cap and the newsletter kill switch stop it too.

import { ulid } from "@rlr/core";
import { openInboxItem } from "@rlr/core/inbox";
import { liveQuizzes, READER_CLASSES } from "@rlr/core/quiz";
import {
  effectiveInputs,
  followedReleases,
  getReaderProfile,
  picksFor,
  profileFor,
  savedQueryPicks,
} from "@rlr/core/readers";
import { books, emailConsents, emailSends, newsletterIssues, savedQueries, users } from "@rlr/core/schema";
import { formatDate } from "@rlr/core/site";
import { type DigestParts, renderDigest } from "@rlr/email";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import {
  addDays,
  footerFor,
  isoDay,
  type MailContext,
  mailContext,
  marketingReady,
  pickBook,
  queueRendered,
  releaseBook,
} from "./mail";
import type { JobContext } from "./types";

/** ISO-8601 week, e.g. "2026-W40": Thursday's and Friday's are the same. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface IssueContent {
  newBookIds: string[];
  quiz: { slug: string; title: string } | null;
  sendDate: string;
}

export async function buildDigestIssue(ctx: JobContext): Promise<number> {
  const { db, now } = ctx;
  const week = isoWeek(now);
  const [existing] = await db
    .select({ id: newsletterIssues.id })
    .from(newsletterIssues)
    .where(and(eq(newsletterIssues.kind, "weekly"), eq(newsletterIssues.week, week)));
  if (existing) return 0;
  const fresh = await db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        eq(books.visibility, "published"),
        isNull(books.redirectTo),
        gte(books.publishedAt, addDays(now, -7).toISOString()),
      ),
    )
    .orderBy(desc(books.publishedAt))
    .limit(400);
  const quizzes = (await liveQuizzes(db)).filter((q) => q.kind === "fun");
  const weekNo = Number(week.slice(-2));
  const quiz = quizzes.length ? quizzes[weekNo % quizzes.length] : undefined;
  const content: IssueContent = {
    newBookIds: fresh.map((b) => b.id),
    quiz: quiz ? { slug: quiz.slug, title: quiz.title } : null,
    // The send day, for the subject line: this week's Friday.
    sendDate: isoDay(addDays(now, (5 - now.getUTCDay() + 7) % 7)),
  };
  await db.insert(newsletterIssues).values({
    id: ulid(),
    kind: "weekly",
    week,
    status: "ready",
    content: content as unknown as Record<string, unknown>,
    createdAt: now.toISOString(),
  });
  ctx.log.info("digest.built", { week, new_books: content.newBookIds.length });
  return 1;
}

/** Pause the issue when bounces or complaints cross their limits (after enough sends to judge). */
async function tripped(mc: MailContext, issueId: string): Promise<string | null> {
  const rows = await mc.db
    .select({ status: emailSends.status, n: count() })
    .from(emailSends)
    .where(eq(emailSends.issueId, issueId))
    .groupBy(emailSends.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const total = (by.sent ?? 0) + (by.delivered ?? 0) + (by.bounced ?? 0) + (by.complained ?? 0);
  if (total < 200) return null;
  if ((by.complained ?? 0) / total > mc.settings["email.circuit.complaint_rate"]) return "complaints";
  if ((by.bounced ?? 0) / total > mc.settings["email.circuit.bounce_rate"]) return "bounces";
  return null;
}

export async function sendDigestChunk(ctx: JobContext): Promise<number> {
  const mc = await mailContext(ctx);
  if (!mc.settings["flags.newsletter_send"]) return 0;
  const [issue] = await mc.db
    .select()
    .from(newsletterIssues)
    .where(
      and(
        inArray(newsletterIssues.status, ["ready", "sending"]),
        gte(newsletterIssues.createdAt, addDays(mc.now, -4).toISOString()),
      ),
    )
    .orderBy(desc(newsletterIssues.createdAt))
    .limit(1);
  if (!issue) return 0;
  const content = issue.content as unknown as IssueContent;
  // Friday 13:00 UTC at the earliest (a US morning).
  if (mc.now.toISOString() < `${content.sendDate}T13:00:00.000Z`) return 0;
  if (!(await marketingReady(mc))) return 0;

  const reason = await tripped(mc, issue.id);
  if (reason) {
    await mc.db.update(newsletterIssues).set({ status: "paused" }).where(eq(newsletterIssues.id, issue.id));
    await openInboxItem(mc.db, {
      type: "system_alert",
      title: `Patch Notes ${issue.week} paused: too many ${reason}`,
      subjectType: "newsletter_issue",
      subjectId: issue.id,
      payload: { week: issue.week, reason },
      priority: 95,
      dedupeKey: `digest.paused:${issue.id}`,
    });
    mc.log.error("digest.circuit_open", { week: issue.week, reason });
    return 0;
  }
  const [today] = await mc.db
    .select({ n: count() })
    .from(emailSends)
    .where(gte(emailSends.createdAt, `${isoDay(mc.now)}T00:00:00.000Z`));
  if ((today?.n ?? 0) >= mc.settings["email.daily_cap"]) {
    mc.log.warn("digest.daily_cap", { sent_today: today?.n ?? 0 });
    return 0;
  }

  const chunk = mc.settings["email.digest_chunk"];
  const readers = await mc.db
    .select({ userId: emailConsents.userId, email: users.email })
    .from(emailConsents)
    .innerJoin(users, eq(users.id, emailConsents.userId))
    .where(
      and(
        eq(emailConsents.list, "weekly_digest"),
        eq(emailConsents.status, "active"),
        issue.cursor ? gt(emailConsents.userId, issue.cursor) : undefined,
      ),
    )
    .orderBy(asc(emailConsents.userId))
    .limit(chunk);

  const newIds = new Set(content.newBookIds);
  const src = `src=nl&i=${issue.id}`;
  let queued = 0;
  let skipped = 0;
  for (const r of readers) {
    const parts = await digestFor(mc, r.userId, newIds, content, src);
    if (!parts) {
      skipped++;
      continue;
    }
    const email = renderDigest(parts.parts);
    await queueRendered(mc, {
      to: r.email,
      userId: r.userId,
      template: "weekly_digest",
      issueId: issue.id,
      stream: "marketing",
      ...email,
      headers: parts.headers,
    });
    queued++;
  }
  const done = readers.length < chunk;
  const stats = issue.stats ?? {};
  await mc.db
    .update(newsletterIssues)
    .set({
      status: done ? "sent" : "sending",
      cursor: readers.at(-1)?.userId ?? issue.cursor,
      stats: { ...stats, queued: (stats.queued ?? 0) + queued, skipped: (stats.skipped ?? 0) + skipped },
      ...(done ? { sentAt: mc.now.toISOString() } : {}),
    })
    .where(eq(newsletterIssues.id, issue.id));
  mc.log.info("digest.chunk", { week: issue.week, queued, skipped, done });
  return queued;
}

async function digestFor(
  mc: MailContext,
  userId: string,
  newIds: ReadonlySet<string>,
  content: IssueContent,
  src: string,
): Promise<{ parts: DigestParts; headers: Record<string, string> } | null> {
  const profile = await getReaderProfile(mc.db, userId);
  const className = READER_CLASSES.find((c) => c.key === profile.readerClass)?.name ?? null;
  const today = isoDay(mc.now);
  const [out, soon] = await Promise.all([
    followedReleases(mc.db, userId, { from: isoDay(addDays(mc.now, -7)), to: today }),
    followedReleases(mc.db, userId, { from: isoDay(addDays(mc.now, 1)), to: isoDay(addDays(mc.now, 30)) }),
  ]);
  const scale = mc.settings["quiz.fun_effect_importance"];
  const pickOpts = { options: mc.options, quizScale: scale };
  const profileP = mc.matrix ? profileFor(mc.matrix, await effectiveInputs(mc.db, userId), scale) : null;
  let matches =
    mc.matrix && profileP
      ? await picksFor(mc.db, mc.matrix, profileP, { ...pickOpts, limit: 5, only: newIds })
      : [];

  const saved = await mc.db
    .select()
    .from(savedQueries)
    .where(and(eq(savedQueries.userId, userId), eq(savedQueries.alert, "digest")));
  const savedSearches: DigestParts["savedSearches"] = [];
  for (const s of saved.slice(0, 5)) {
    const picks = mc.matrix
      ? await savedQueryPicks(mc.db, mc.matrix, s, newIds, { ...pickOpts, limit: 3 })
      : [];
    if (picks.length)
      savedSearches.push({
        name: s.name,
        url: `${mc.origin}/${s.kind === "match" ? "match/r" : "find"}?${s.params}`,
        books: await Promise.all(picks.map((p) => pickBook(mc, p, { src }))),
      });
  }

  const quiet = !out.length && !soon.length && !matches.length && !savedSearches.length;
  if (quiet) {
    if (mc.settings["email.digest_quiet"] === "skip") return null;
    // The short "quiet week" version: their best picks overall.
    matches =
      mc.matrix && profileP ? await picksFor(mc.db, mc.matrix, profileP, { ...pickOpts, limit: 3 }) : [];
  }
  const { footer, headers } = await footerFor(mc, userId, "weekly_digest");
  return {
    headers,
    parts: {
      week: formatDate(content.sendDate, "day"),
      className,
      outFromFollows: out.slice(0, 8).map((r) => releaseBook(mc, r, src)),
      newMatches: await Promise.all(matches.map((p) => pickBook(mc, p, { src, userId, marks: true }))),
      comingSoon: soon.slice(0, 5).map((r) => releaseBook(mc, r, src)),
      savedSearches,
      quiz: content.quiz
        ? { title: content.quiz.title, url: `${mc.origin}/quiz/${content.quiz.slug}?src=newsletter` }
        : null,
      footer,
    },
  };
}
