// Applying the content kinds (M7, DESIGN §14): news scans become briefs to check, guide drafts
// become posts that wait for a veto, guest reviews annotate the owner's inbox, and interview
// formats go back to the author for approval. Nothing here publishes on the run's word alone.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { notifyAuthor } from "../authors/notices";
import { titleKey } from "../catalog/normalize";
import { acceptPitch, openReviewItem } from "../content/guest";
import { createPost, type RenderEnv } from "../content/posts";
import { autoPostMarkdown, validateAutoPost } from "../content/validate";
import type { Db } from "../db";
import type { ProposalStatus } from "../db/schema";
import {
  authors,
  books,
  bookTags,
  guestSubmissions,
  inboxItems,
  interviewResponses,
  newsTips,
  posts,
  series,
  tags,
} from "../db/schema";
import { ulid } from "../ids";
import { decideInboxItem, openInboxItem } from "../inbox";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { matchText } from "./citations";
import type { QueueItem } from "./queue";
import type {
  GuestReviewProposal,
  InterviewFormatProposal,
  NewsScanProposal,
  PostDraftProposal,
} from "./schemas";

export interface ContentHandled {
  status: ProposalStatus;
  reasons: string[];
  result?: unknown;
  close: "done" | "rejected" | null;
}

export const DEFAULT_RENDER_ENV: RenderEnv = {
  origin: "https://readlitrpg.com",
  mediaOrigin: "https://media.readlitrpg.com",
};

// ---------------------------------------------------------------------------------------------
// news_scan

export async function handleNewsScan(db: Db, p: NewsScanProposal, item: QueueItem): Promise<ContentHandled> {
  if (item.subjectType !== "news_day")
    return { status: "rejected", reasons: ["not a news day"], close: null };
  let added = 0;
  const dropped: string[] = [];
  for (const b of p.briefs) {
    // Keep only subjects that exist; the checker looks for them on the cited page.
    const subjects: typeof b.subjects = [];
    for (const s of b.subjects) {
      const table = s.kind === "book" ? books : s.kind === "series" ? series : authors;
      const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, s.id));
      if (row) subjects.push(s);
      else dropped.push(`${s.kind} ${s.id} isn't in the catalog`);
    }
    const rows = await db
      .insert(newsTips)
      .values({
        id: ulid(),
        source: "research",
        kind: "brief",
        subject: b.headline,
        body: b.body,
        sourceUrl: b.sources[0]?.url ?? null,
        data: { brief: { ...b, subjects } },
        status: "queued",
        dedupeKey: `brief:${matchText(b.headline).trim().slice(0, 150)}`,
      })
      .onConflictDoNothing()
      .returning({ id: newsTips.id });
    if (!rows[0]) {
      dropped.push(`"${b.headline.slice(0, 60)}" was already briefed`);
      continue;
    }
    added++;
    if (b.tip_ids?.length)
      await db
        .update(newsTips)
        .set({ status: "briefed", updatedAt: nowIso() })
        .where(and(inArray(newsTips.id, b.tip_ids), inArray(newsTips.source, ["author", "publisher"])));
  }
  return { status: "accepted", reasons: dropped.slice(0, 10), result: { briefs: added }, close: "done" };
}

// ---------------------------------------------------------------------------------------------
// post_draft

/** The books a guide on a tag may use: published and clearly carrying the tag. */
export async function guideBooks(db: Db, tagSlug: string, limit = 60) {
  return db
    .select({ id: books.id, title: books.title, score: bookTags.score })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .innerJoin(books, eq(books.id, bookTags.bookId))
    .where(and(eq(tags.slug, tagSlug), eq(books.visibility, "published"), isNull(books.redirectTo)))
    .orderBy(desc(bookTags.score))
    .limit(limit)
    .then((rows) => rows.filter((r) => r.score >= 0.6));
}

export async function handlePostDraft(
  db: Db,
  p: PostDraftProposal,
  item: QueueItem,
  settings: Settings,
  env: RenderEnv,
  now = new Date(),
): Promise<ContentHandled> {
  if (item.subjectType !== "guide_tag" || p.topic_key !== `guide:tag:${item.subjectId}`)
    return { status: "rejected", reasons: [`topic_key must be guide:tag:${item.subjectId}`], close: null };
  const [existing] = await db.select({ id: posts.id }).from(posts).where(eq(posts.genKey, p.topic_key));
  if (existing) return { status: "rejected", reasons: ["a guide on this topic exists"], close: "done" };
  const [tag] = await db.select({ name: tags.name }).from(tags).where(eq(tags.slug, item.subjectId));
  const allowed = await guideBooks(db, item.subjectId);
  const others = await db
    .select({ title: books.title })
    .from(books)
    .where(and(eq(books.visibility, "published"), isNull(books.redirectTo)))
    .limit(5_000);
  const allowedKeys = new Set(allowed.map((b) => titleKey(b.title)));
  const post = { title: p.title, dek: p.dek, sections: p.sections, outro_md: p.outro_md };
  const errors = validateAutoPost(post, {
    books: allowed,
    facts: { tag: tag?.name ?? item.subjectId, books: allowed.length },
    minBooks: 5,
    otherTitles: others.map((o) => o.title).filter((t) => !allowedKeys.has(titleKey(t))),
  });
  if (errors.length) return { status: "rejected", reasons: errors.slice(0, 15), close: null };
  const draft = await createPost(
    db,
    {
      type: "ai_editorial",
      title: p.title,
      dek: p.dek,
      bodyMd: autoPostMarkdown(post),
      genKey: p.topic_key,
      status: "in_review",
      aiInvolvement: "generated",
      data: {
        topic: p.topic_key,
        sections: p.sections.map((s) => ({ heading: s.heading, refs: s.book_ids })),
      },
      createdBy: "editorial",
    },
    env,
  );
  const hours = settings["blog.ai_draft_veto_hours"];
  await openInboxItem(db, {
    type: "post_review",
    title: `Guide drafted: "${p.title}"`,
    subjectType: "post",
    subjectId: draft.id,
    priority: 35,
    payload: { postId: draft.id, title: p.title, topic: p.topic_key },
    aiRecommendation: "approve",
    aiSummary: `Written from our catalog: every book is a live card and the validator passed. It takes the next guide slot in ${Math.round(hours / 24)} days unless you reject it.`,
    defaultAction: "approve",
    defaultActionAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    dedupeKey: `post_review:${draft.id}`,
  });
  return { status: "accepted", reasons: [], result: { postId: draft.id }, close: "done" };
}

// ---------------------------------------------------------------------------------------------
// guest_review

const RECOMMEND = { approve: "approve", changes: "edit", decline: "reject" } as const;

export async function handleGuestReview(
  db: Db,
  p: GuestReviewProposal,
  item: QueueItem,
  settings: Settings,
  now = new Date(),
): Promise<ContentHandled> {
  const expected = p.stage === "pitch" ? "guest_pitch" : "guest_post";
  if (item.subjectType !== expected)
    return { status: "rejected", reasons: [`this item is a ${item.subjectType}`], close: null };
  const [sub] = await db.select().from(guestSubmissions).where(eq(guestSubmissions.postId, item.subjectId));
  if (!sub) return { status: "rejected", reasons: ["the submission is gone"], close: "rejected" };
  const [author] = await db
    .select({ trust: authors.trustLevel })
    .from(authors)
    .where(eq(authors.id, sub.authorId));
  const screen = {
    verdict: p.verdict,
    issues: p.issues,
    self_promo_mentions: p.self_promo_mentions,
    summary: p.summary,
    suggested_title: p.suggested_title ?? null,
    suggested_dek: p.suggested_dek ?? null,
    at: nowIso(now),
  };
  await db
    .update(guestSubmissions)
    .set({ aiScreen: { ...(sub.aiScreen ?? {}), [p.stage]: screen }, updatedAt: nowIso(now) })
    .where(eq(guestSubmissions.postId, sub.postId));
  const clean = p.verdict === "approve" && p.issues.length === 0 && p.self_promo_mentions <= 1;
  const open =
    p.stage === "pitch"
      ? (
          await db
            .select()
            .from(inboxItems)
            .where(
              and(
                eq(inboxItems.type, "guest_pitch"),
                eq(inboxItems.subjectId, sub.postId),
                eq(inboxItems.status, "open"),
              ),
            )
        )[0]
      : await openReviewItem(db, sub.postId);
  if (open)
    await db
      .update(inboxItems)
      .set({
        aiSummary: p.summary,
        aiRecommendation: RECOMMEND[p.verdict],
        riskScore: Math.min(100, p.issues.length * 20 + Math.max(0, p.self_promo_mentions - 1) * 10),
        // A clean post from a verified author approves itself after the review window (§8.2).
        ...(p.stage === "post" && clean && (author?.trust === "T1" || author?.trust === "T2")
          ? {
              defaultAction: "approve" as const,
              defaultActionAt: new Date(
                now.getTime() + settings["blog.guest_review_days"] * 86_400_000,
              ).toISOString(),
            }
          : {}),
        updatedAt: nowIso(now),
      })
      .where(eq(inboxItems.id, open.id));
  // T2 authors with an on-topic pitch are accepted straight away (§14.3 step 2).
  if (p.stage === "pitch" && clean && author?.trust === "T2" && (await acceptPitch(db, sub.postId)) && open)
    await decideInboxItem(db, open.id, { status: "auto_approved", decidedBy: "system:guest_review" });
  return { status: "accepted", reasons: [], result: { stage: p.stage, clean }, close: "done" };
}

// ---------------------------------------------------------------------------------------------
// interview_format

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. Banded: O(n·max). */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Map<number, number>();
  for (let j = 0; j <= Math.min(b.length, max); j++) prev.set(j, j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Map<number, number>();
    let best = max + 1;
    for (let j = Math.max(0, i - max); j <= Math.min(b.length, i + max); j++) {
      const v =
        j === 0
          ? i
          : Math.min(
              (prev.get(j) ?? max + 1) + 1,
              (cur.get(j - 1) ?? max + 1) + 1,
              (prev.get(j - 1) ?? max + 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
      cur.set(j, v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev.get(b.length) ?? max + 1;
}

/** A "typo fix" keeps the author's words: a few characters at most, and the same numbers. */
export function typoOnly(original: string, fixed: string): boolean {
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join(",");
  if (digits(original) !== digits(fixed)) return false;
  const max = Math.max(3, Math.ceil(original.length * 0.04));
  return boundedDistance(original, fixed, max) <= max;
}

export async function handleInterviewFormat(
  db: Db,
  p: InterviewFormatProposal,
  item: QueueItem,
): Promise<ContentHandled> {
  if (item.subjectType !== "interview")
    return { status: "rejected", reasons: ["not an interview"], close: null };
  const [row] = await db.select().from(interviewResponses).where(eq(interviewResponses.id, item.subjectId));
  if (row?.status !== "answered")
    return { status: "rejected", reasons: ["the interview isn't waiting"], close: "rejected" };
  const errors: string[] = [];
  for (const k of p.order) if (!row.answers[k]) errors.push(`order: ${k} wasn't answered`);
  for (const [k, text] of Object.entries(p.fixes ?? {}))
    if (row.answers[k] && !typoOnly(row.answers[k], text)) errors.push(`fixes.${k}: more than a typo fix`);
  if (errors.length) return { status: "rejected", reasons: errors, close: null };
  await db
    .update(interviewResponses)
    .set({
      status: "formatted",
      formatted: { headline: p.headline, intro: p.intro, order: p.order, fixes: p.fixes ?? {} },
      updatedAt: nowIso(),
    })
    .where(eq(interviewResponses.id, row.id));
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, row.bookId));
  await notifyAuthor(db, {
    authorId: row.authorId,
    userId: row.userId,
    kind: "interview_ready",
    payload: { interviewId: row.id, title: book?.title ?? "", headline: p.headline },
  });
  return { status: "accepted", reasons: [], result: { answers: p.order.length }, close: "done" };
}
