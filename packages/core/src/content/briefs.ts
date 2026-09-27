// News briefs (DESIGN §14.6): "No rumors: every news item links its source." The morning run's
// briefs arrive as research tips. The jobs Worker fetches each cited page (never Amazon, Audible,
// Royal Road or Goodreads) and looks for the brief's subject on it: a book's title and an author,
// a series or an author's name. A checked brief publishes (`news.auto_publish_briefs`); anything
// else, including a brief with no catalog subject, waits for the owner.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { authors, bookAuthors, books, newsTips, series } from "../db/schema";
import { htmlToText, matchText, pageMentions } from "../editorial/citations";
import { type InboxHandler, openInboxItem } from "../inbox";
import type { Logger } from "../log";
import { SafeFetchError, safeFetch } from "../net/safe-fetch";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import type { UndoSpec } from "../undo";
import { createPost, publishPost, type RenderEnv } from "./posts";

export interface Brief {
  headline: string;
  body: string;
  sources: { url: string; title?: string }[];
  subjects: { kind: "book" | "series" | "author"; id: string }[];
  confidence: "low" | "medium" | "high";
}

type Tip = typeof newsTips.$inferSelect;
const MAX_TRIES = 3;

/** What a page must say for each subject. */
async function subjectNames(db: Db, subjects: Brief["subjects"]) {
  const out: { kind: string; id: string; title: string; authors: string[] }[] = [];
  for (const s of subjects) {
    if (s.kind === "book") {
      const [b] = await db.select({ title: books.title }).from(books).where(eq(books.id, s.id));
      if (!b) continue;
      const names = await db
        .select({ name: authors.name })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(eq(bookAuthors.bookId, s.id));
      out.push({ ...s, title: b.title, authors: names.map((n) => n.name) });
    } else if (s.kind === "series") {
      const [x] = await db.select({ name: series.name }).from(series).where(eq(series.id, s.id));
      if (x) out.push({ ...s, title: x.name, authors: [] });
    } else {
      const [x] = await db.select({ name: authors.name }).from(authors).where(eq(authors.id, s.id));
      if (x) out.push({ ...s, title: x.name, authors: [] });
    }
  }
  return out;
}

function mentions(text: string, s: { kind: string; title: string; authors: string[] }) {
  if (s.kind === "book") return pageMentions(text, s.title, s.authors);
  const name = matchText(s.title).trim();
  return name.length >= 3 && matchText(text).includes(` ${name} `);
}

/** Publish a brief as a news post, citing its sources, with cards for the books it's about. */
export async function publishBrief(
  db: Db,
  tip: Tip,
  env: RenderEnv,
  now = new Date(),
): Promise<string | null> {
  const brief = (tip.data as { brief?: Brief } | null)?.brief;
  if (!brief || tip.postId) return tip.postId;
  const cards = brief.subjects.filter((s) => s.kind === "book").map((s) => `[[book:${s.id}]]`);
  const post = await createPost(
    db,
    {
      type: "news",
      title: brief.headline,
      dek: brief.body.split(/(?<=[.!?])\s/)[0]?.slice(0, 240) ?? null,
      bodyMd: [brief.body, ...cards].join("\n\n"),
      sources: brief.sources,
      genKey: `brief:${tip.id}`,
      aiInvolvement: "assisted",
      disclosure: "Written with AI assistance from the sources below, which we checked",
      createdBy: "system",
    },
    env,
  );
  await publishPost(db, post.id, now);
  await db
    .update(newsTips)
    .set({ status: "briefed", postId: post.id, updatedAt: nowIso(now) })
    .where(eq(newsTips.id, tip.id));
  return post.id;
}

async function toInbox(db: Db, tip: Tip, brief: Brief, why: string) {
  await openInboxItem(db, {
    type: "news_brief",
    title: `News brief: "${brief.headline.slice(0, 150)}"`,
    subjectType: "news_tip",
    subjectId: tip.id,
    priority: 55,
    payload: { tipId: tip.id, headline: brief.headline, body: brief.body, sources: brief.sources, why },
    aiSummary: why,
    aiRecommendation: "escalate",
    dedupeKey: `news_brief:${tip.id}`,
  });
  await db.update(newsTips).set({ status: "new", updatedAt: nowIso() }).where(eq(newsTips.id, tip.id));
}

/** Check queued briefs (`news.briefs`, every 10 minutes). Returns how many were settled. */
export async function checkBriefs(
  db: Db,
  env: RenderEnv,
  settings: Pick<Settings, "news.auto_publish_briefs">,
  opts: { fetch?: typeof fetch; log?: Logger; limit?: number; now?: Date } = {},
): Promise<number> {
  const queued = await db
    .select()
    .from(newsTips)
    .where(and(eq(newsTips.source, "research"), eq(newsTips.status, "queued")))
    .orderBy(asc(newsTips.createdAt))
    .limit(opts.limit ?? 8);
  let settled = 0;
  for (const tip of queued) {
    const data = (tip.data ?? {}) as { brief?: Brief; tries?: number };
    const brief = data.brief;
    if (!brief) {
      await db.update(newsTips).set({ status: "rejected" }).where(eq(newsTips.id, tip.id));
      continue;
    }
    const subjects = await subjectNames(db, brief.subjects);
    if (subjects.length === 0) {
      await toInbox(db, tip, brief, "No catalog book, series or author to check the source against.");
      settled++;
      continue;
    }
    let verified: string | null = null;
    let networkOnly = true;
    for (const source of brief.sources) {
      try {
        const res = await safeFetch(source.url, {
          allowHosts: ["*"],
          headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
          timeoutMs: 8_000,
          maxBytes: 2_000_000,
          fetch: opts.fetch,
        });
        networkOnly = false;
        if (res.status === 200 && subjects.some((s) => mentions(htmlToText(res.text), s))) {
          verified = source.url;
          break;
        }
      } catch (error) {
        if (error instanceof SafeFetchError && error.code === "blocked") networkOnly = false;
      }
    }
    const tries = (data.tries ?? 0) + 1;
    if (!verified && networkOnly && tries < MAX_TRIES) {
      await db
        .update(newsTips)
        .set({ data: { ...data, tries } })
        .where(eq(newsTips.id, tip.id));
      continue;
    }
    settled++;
    if (verified && settings["news.auto_publish_briefs"]) {
      await publishBrief(db, tip, env, opts.now);
      opts.log?.info("news.brief_published", { tip: tip.id, source: verified });
    } else
      await toInbox(
        db,
        tip,
        brief,
        verified
          ? `Source checked (${new URL(verified).host} names ${subjects[0]?.title}). Auto-publishing is off.`
          : `None of the cited pages names ${subjects.map((s) => s.title).join(" or ")}. Check before publishing.`,
      );
  }
  return settled;
}

const DEFAULT_ENV: RenderEnv = {
  origin: "https://readlitrpg.com",
  mediaOrigin: "https://media.readlitrpg.com",
};

export const newsBriefHandler: InboxHandler = {
  async approve(db, item, ctx) {
    const tipId = (item.payload as { tipId?: string } | null)?.tipId ?? item.subjectId;
    if (!tipId) return;
    const [tip] = await db.select().from(newsTips).where(eq(newsTips.id, tipId));
    if (!tip || tip.status === "briefed") return;
    const postId = await publishBrief(db, tip, ctx.renderEnv ?? DEFAULT_ENV, ctx.now);
    return postId ? ({ kind: "post_status", postId, to: "unpublished" } satisfies UndoSpec) : null;
  },
  async reject(db, item) {
    const tipId = (item.payload as { tipId?: string } | null)?.tipId ?? item.subjectId;
    if (tipId)
      await db
        .update(newsTips)
        .set({ status: "rejected", updatedAt: nowIso() })
        .where(and(eq(newsTips.id, tipId), inArray(newsTips.status, ["new", "queued"])));
  },
};
