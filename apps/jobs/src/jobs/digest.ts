// Patch Notes, the weekly digest (DESIGN §13.5). Thursday freezes the issue: this week's new books,
// the quiz of the week. From Friday 13:00 UTC each run builds the next chunk of readers from their
// own profile, follows and saved searches, and queues their email. A circuit breaker pauses the
// issue if bounces or complaints climb; a daily cap and the newsletter kill switch stop it too.

import { ulid } from "@rlr/core";
import { countEmailSends, type Placement, placementsFor } from "@rlr/core/ads";
import { BLOG_TYPES, listPosts, postPath } from "@rlr/core/content";
import { openInboxItem } from "@rlr/core/inbox";
import { hardFilter, indexOfBook } from "@rlr/core/match";
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
import { type DigestParts, type EmailAd, renderDigest } from "@rlr/email";
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
  /** The week's newest blog post (M7). */
  post?: { title: string; path: string; dek: string | null } | null;
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
  const [latest] = await listPosts(db, { types: BLOG_TYPES, limit: 1 });
  const content: IssueContent = {
    post:
      latest && latest.publishedAt >= addDays(now, -7).toISOString()
        ? { title: latest.title, path: postPath(latest), dek: latest.dek }
        : null,
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
export async function tripped(mc: MailContext, issueId: string): Promise<string | null> {
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
        eq(newsletterIssues.kind, "weekly"),
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
  const ads = await newsletterAds(mc, content.sendDate);
  const sends = new Map<string, { campaignKey: string; slot: string; n: number }>();
  let queued = 0;
  let skipped = 0;
  for (const r of readers) {
    const parts = await digestFor(mc, r.userId, newIds, content, src, ads);
    if (!parts) {
      skipped++;
      continue;
    }
    for (const ad of parts.adKeys) {
      const k = `${ad.campaignKey}|${ad.slot}`;
      sends.set(k, { ...ad, n: (sends.get(k)?.n ?? 0) + 1 });
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
  if (sends.size) await countEmailSends(mc.db, isoDay(mc.now), sends);
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

const NEWSLETTER_SLOTS = ["newsletter_top", "newsletter_standard_1", "newsletter_standard_2"];

/**
 * This issue's placements (DESIGN §11.2): the same for every reader, then filtered per reader.
 * No built-in house ads in email: an unsold slot is simply left out.
 */
async function newsletterAds(mc: MailContext, sendDate: string): Promise<Placement[]> {
  if (!mc.settings["flags.ads_serving"] || mc.settings["ads.max_sponsored_per_email"] <= 0) return [];
  try {
    return await placementsFor(mc.db, mc.keys, {
      slots: NEWSLETTER_SLOTS,
      date: sendDate,
      builtins: false,
      now: mc.now,
    });
  } catch (error) {
    // An ad problem never holds up the newsletter.
    mc.log.error("digest.ads_failed", { error });
    return [];
  }
}

async function digestFor(
  mc: MailContext,
  userId: string,
  newIds: ReadonlySet<string>,
  content: IssueContent,
  src: string,
  placements: Placement[] = [],
): Promise<{
  parts: DigestParts;
  headers: Record<string, string>;
  adKeys: { campaignKey: string; slot: string }[];
} | null> {
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
  // A promoted book must pass the reader's hard no's and not be one they've already read (§11.5).
  // Without a profile to check against, only placements without a book are shown.
  const index = mc.matrix ? indexOfBook(mc.matrix) : null;
  const ads = placements
    .filter((pl) => {
      if (!pl.book) return true;
      const i = index?.get(pl.book.id);
      return (
        mc.matrix !== null &&
        profileP !== null &&
        i !== undefined &&
        !hardFilter(mc.matrix, i, profileP, mc.options)
      );
    })
    .slice(0, mc.settings["ads.max_sponsored_per_email"]);
  const { footer, headers } = await footerFor(mc, userId, "weekly_digest");
  return {
    headers,
    adKeys: ads.map((x) => ({ campaignKey: x.campaignKey, slot: x.slot })),
    parts: {
      ads: ads.map(
        (x): EmailAd => ({
          position: x.slot === "newsletter_top" ? "top" : "standard",
          label: x.label,
          headline: x.headline,
          body: x.body,
          cta: x.cta,
          url: `${mc.origin}${x.href}`,
          book: x.book ? { title: x.book.title, series: x.book.series?.name ?? null } : null,
        }),
      ),
      week: formatDate(content.sendDate, "day"),
      className,
      outFromFollows: out.slice(0, 8).map((r) => releaseBook(mc, r, src)),
      newMatches: await Promise.all(matches.map((p) => pickBook(mc, p, { src, userId, marks: true }))),
      comingSoon: soon.slice(0, 5).map((r) => releaseBook(mc, r, src)),
      savedSearches,
      quiz: content.quiz
        ? { title: content.quiz.title, url: `${mc.origin}/quiz/${content.quiz.slug}?src=newsletter` }
        : null,
      post: content.post
        ? {
            title: content.post.title,
            url: `${mc.origin}${content.post.path}?src=newsletter`,
            dek: content.post.dek,
          }
        : null,
      footer,
    },
  };
}
