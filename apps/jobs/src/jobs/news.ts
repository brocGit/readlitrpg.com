// The news desk's jobs (DESIGN §14.6, Appendix B): catalog changes become tips every hour;
// "Today in LitRPG" is built and published every morning, then emailed to Patch Notes Daily
// readers and posted to Bluesky and Mastodon when those accounts are set up; weekly and monthly
// roundups are built from the release database.

import { ulid } from "@rlr/core";
import {
  type AutoBuilt,
  buildDailyPost,
  buildMonthlyRoundups,
  buildWeeklyRoundup,
  checkBriefs,
  collectCatalogTips,
  inviteDueInterviews,
  type Post,
  postPath,
  saveAutoPost,
} from "@rlr/core/content";
import { openInboxItem } from "@rlr/core/inbox";
import { safeFetch } from "@rlr/core/net";
import { enqueueJob } from "@rlr/core/scheduler";
import {
  authors,
  bookAuthors,
  books,
  emailConsents,
  emailSends,
  newsletterIssues,
  posts,
  users,
} from "@rlr/core/schema";
import { loadSettings } from "@rlr/core/settings";
import { type EmailBook, renderDaily } from "@rlr/email";
import { and, asc, count, eq, gt, gte, inArray } from "drizzle-orm";
import { tripped } from "./digest";
import { footerFor, isoDay, mailContext, marketingReady, queueRendered } from "./mail";
import type { JobContext } from "./types";

const renderEnv = (ctx: JobContext) => ({
  origin: ctx.env.PUBLIC_ORIGIN.replace(/\/$/, ""),
  mediaOrigin: ctx.env.PUBLIC_MEDIA_ORIGIN.replace(/\/$/, ""),
});

/** Check the morning run's briefs against their sources (`news.briefs`). */
export async function checkNewsBriefs(ctx: JobContext): Promise<number> {
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  const settled = await checkBriefs(ctx.db, renderEnv(ctx), settings, {
    fetch: ctx.fetch,
    log: ctx.log,
    now: ctx.now,
  });
  if (settled) await enqueueJob(ctx.db, ctx.env.Q_JOBS, "og.render");
  return settled;
}

export async function inviteInterviews(ctx: JobContext): Promise<number> {
  const invited = await inviteDueInterviews(ctx.db, ctx.now);
  if (invited) ctx.log.info("interviews.invited", { invited });
  return invited;
}

export async function catalogNews(ctx: JobContext): Promise<number> {
  const added = await collectCatalogTips(ctx.db, ctx.now);
  if (added) ctx.log.info("news.tips", { added });
  return added;
}

async function save(ctx: JobContext, built: AutoBuilt): Promise<Post | null> {
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  const { post, outcome } = await saveAutoPost(ctx.db, built, renderEnv(ctx), settings, ctx.now);
  ctx.log.info("news.post", { genKey: built.genKey, outcome, items: built.items });
  if (outcome === "published") {
    await enqueueJob(ctx.db, ctx.env.Q_JOBS, "og.render");
    return post;
  }
  return null;
}

/** "Today in LitRPG" (10:30 UTC). Publishes even on a quiet day: the calendar always has something. */
export async function dailyRoundup(ctx: JobContext): Promise<number> {
  const date = isoDay(ctx.now);
  const post = await save(ctx, await buildDailyPost(ctx.db, date, ctx.now));
  if (post) await postToSocial(ctx, post);
  return post ? 1 : 0;
}

export async function weeklyRoundup(ctx: JobContext): Promise<number> {
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  const built = await buildWeeklyRoundup(ctx.db, ctx.now, settings["blog.min_books_per_roundup"]);
  if (!built) {
    ctx.log.info("news.weekly_skipped", { reason: "too few books" });
    return 0;
  }
  await save(ctx, built);
  return 1;
}

export async function monthlyRoundups(ctx: JobContext): Promise<number> {
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  const built = await buildMonthlyRoundups(ctx.db, ctx.now, settings["blog.min_books_per_roundup"]);
  for (const b of built) await save(ctx, b);
  return built.length;
}

// ---------------------------------------------------------------------------------------------
// Patch Notes Daily

async function emailSections(ctx: JobContext, post: Post, url: (path: string) => string) {
  const sections = ((post.data?.sections ?? []) as { heading: string; refs: string[] }[]).filter(
    (s) => s.refs.length,
  );
  const slugs = [...new Set(sections.flatMap((s) => s.refs))].slice(0, 90);
  const rows = slugs.length
    ? await ctx.db
        .select({ id: books.id, slug: books.slug, title: books.title })
        .from(books)
        .where(inArray(books.slug, slugs))
    : [];
  const names = rows.length
    ? await ctx.db
        .select({ bookId: bookAuthors.bookId, name: authors.name })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(
          inArray(
            bookAuthors.bookId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(bookAuthors.position))
    : [];
  const bySlug = new Map(
    rows.map((r): [string, EmailBook] => [
      r.slug,
      {
        title: r.title,
        url: url(`/books/${r.slug}?src=daily`),
        authors: names
          .filter((n) => n.bookId === r.id)
          .map((n) => n.name)
          .join(", "),
      },
    ]),
  );
  return sections.map((s) => ({
    heading: s.heading,
    books: s.refs.flatMap((ref) => bySlug.get(ref) ?? []).slice(0, 12),
  }));
}

/** Email today's roundup to Patch Notes Daily readers, a chunk a run (11:00–13:55 UTC). */
export async function dailySend(ctx: JobContext): Promise<number> {
  const mc = await mailContext(ctx);
  if (!mc.settings["flags.newsletter_send"]) return 0;
  const date = isoDay(mc.now);
  const [post] = await mc.db
    .select()
    .from(posts)
    .where(and(eq(posts.genKey, `daily:${date}`), eq(posts.status, "published")));
  if (!post) return 0;
  let [issue] = await mc.db
    .select()
    .from(newsletterIssues)
    .where(and(eq(newsletterIssues.kind, "daily"), eq(newsletterIssues.week, date)));
  if (!issue) {
    await mc.db
      .insert(newsletterIssues)
      .values({ id: ulid(), kind: "daily", week: date, status: "ready", content: { postId: post.id } })
      .onConflictDoNothing();
    [issue] = await mc.db
      .select()
      .from(newsletterIssues)
      .where(and(eq(newsletterIssues.kind, "daily"), eq(newsletterIssues.week, date)));
  }
  if (!issue || !["ready", "sending"].includes(issue.status)) return 0;
  if (!(await marketingReady(mc))) return 0;
  const reason = await tripped(mc, issue.id);
  if (reason) {
    await mc.db.update(newsletterIssues).set({ status: "paused" }).where(eq(newsletterIssues.id, issue.id));
    await openInboxItem(mc.db, {
      type: "system_alert",
      title: `Patch Notes Daily ${date} paused: too many ${reason}`,
      subjectType: "newsletter_issue",
      subjectId: issue.id,
      payload: { date, reason },
      priority: 95,
      dedupeKey: `daily.paused:${issue.id}`,
    });
    return 0;
  }
  const [today] = await mc.db
    .select({ n: count() })
    .from(emailSends)
    .where(gte(emailSends.createdAt, `${date}T00:00:00.000Z`));
  if ((today?.n ?? 0) >= mc.settings["email.daily_cap"]) return 0;

  const chunk = mc.settings["email.digest_chunk"];
  const readers = await mc.db
    .select({ userId: emailConsents.userId, email: users.email })
    .from(emailConsents)
    .innerJoin(users, eq(users.id, emailConsents.userId))
    .where(
      and(
        eq(emailConsents.list, "daily_digest"),
        eq(emailConsents.status, "active"),
        issue.cursor ? gt(emailConsents.userId, issue.cursor) : undefined,
      ),
    )
    .orderBy(asc(emailConsents.userId))
    .limit(chunk);
  const url = (path: string) => `${mc.origin}${path}`;
  const sections = await emailSections(ctx, post, url);
  let queued = 0;
  for (const r of readers) {
    const { footer, headers } = await footerFor(mc, r.userId, "daily_digest");
    const email = renderDaily({
      title: post.title,
      dek: post.dek ?? "",
      url: url(`${postPath(post)}?src=daily`),
      sections,
      footer,
    });
    await queueRendered(mc, {
      to: r.email,
      userId: r.userId,
      template: "daily_digest",
      issueId: issue.id,
      stream: "marketing",
      ...email,
      headers,
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
      stats: { ...stats, queued: (stats.queued ?? 0) + queued },
      ...(done ? { sentAt: mc.now.toISOString() } : {}),
    })
    .where(eq(newsletterIssues.id, issue.id));
  if (queued) mc.log.info("daily.chunk", { date, queued, done });
  return queued;
}

// ---------------------------------------------------------------------------------------------
// Bluesky and Mastodon (§14.2 distribution): official APIs, only when the accounts are configured.

export async function postToSocial(ctx: JobContext, post: Post): Promise<number> {
  const marker = `social:${post.id}`;
  if (await ctx.env.CONFIG.get(marker)) return 0;
  const link = `${ctx.env.PUBLIC_ORIGIN.replace(/\/$/, "")}${postPath(post)}`;
  const text = `${post.title}\n\n${post.dek ?? ""}`.trim();
  let posted = 0;
  const env = ctx.env;
  if (env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD) {
    try {
      const opts = {
        allowHosts: ["bsky.social"],
        method: "POST" as const,
        fetch: ctx.fetch,
        headers: { "content-type": "application/json" },
      };
      const session = await safeFetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
        ...opts,
        body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
      });
      const { accessJwt, did } = JSON.parse(session.text) as { accessJwt?: string; did?: string };
      if (session.status !== 200 || !accessJwt || !did) throw new Error(`session ${session.status}`);
      const res = await safeFetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
        ...opts,
        headers: { ...opts.headers, authorization: `Bearer ${accessJwt}` },
        body: JSON.stringify({
          repo: did,
          collection: "app.bsky.feed.post",
          record: {
            $type: "app.bsky.feed.post",
            text: [...text].slice(0, 280).join(""),
            createdAt: ctx.now.toISOString(),
            embed: {
              $type: "app.bsky.embed.external",
              external: { uri: link, title: post.title, description: post.dek ?? "" },
            },
          },
        }),
      });
      if (res.status !== 200) throw new Error(`createRecord ${res.status}`);
      posted++;
    } catch (error) {
      ctx.log.warn("social.bluesky_failed", { error: String(error) });
    }
  }
  if (env.MASTODON_URL && env.MASTODON_TOKEN) {
    try {
      const base = new URL(env.MASTODON_URL);
      const res = await safeFetch(`${base.origin}/api/v1/statuses`, {
        allowHosts: [base.hostname],
        method: "POST",
        fetch: ctx.fetch,
        headers: {
          authorization: `Bearer ${env.MASTODON_TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": marker,
        },
        body: JSON.stringify({ status: `${text}\n\n${link}`.slice(0, 480), visibility: "public" }),
      });
      if (res.status !== 200) throw new Error(`statuses ${res.status}`);
      posted++;
    } catch (error) {
      ctx.log.warn("social.mastodon_failed", { error: String(error) });
    }
  }
  if (posted) await ctx.env.CONFIG.put(marker, ctx.now.toISOString(), { expirationTtl: 30 * 86_400 });
  return posted;
}
