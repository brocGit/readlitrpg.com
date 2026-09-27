// Author interviews (DESIGN §14.5): 21–35 days before a release, verified authors are invited to
// answer six or more questions in their dashboard. An editorial run picks the order, writes a
// headline and a two-sentence intro and fixes typos only; the author approves the result; it
// publishes the week before release. Every word of the answers is the author's.

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { notifyAuthor } from "../authors/notices";
import type { Db } from "../db";
import { authors, bookAuthors, books, interviewResponses, releases } from "../db/schema";
import { enqueue } from "../editorial/queue";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { createPost, type RenderEnv } from "./posts";

export const INTERVIEW_QUESTIONS = [
  { key: "system", question: "What's the system in your book, and how did you design it?" },
  { key: "progression", question: "Which progression beat are you proudest of, without spoilers?" },
  { key: "hook", question: "How would you pitch this book to a reader in one or two sentences?" },
  { key: "origin", question: "Where did the idea for the series come from?" },
  { key: "mc", question: "What makes your main character tick?" },
  { key: "crunch", question: "How much of the system shows on the page, and why that much?" },
  { key: "hardest", question: "What was the hardest part of writing this book?" },
  { key: "changed", question: "What changed most between the first draft and the final book?" },
  { key: "influences", question: "Which games or books shaped the series?" },
  { key: "recs", question: "Three LitRPG or progression fantasy books you'd recommend that aren't yours?" },
  { key: "audio", question: "Is there an audiobook, and what was working with the narrator like?" },
  { key: "next", question: "What can readers look forward to next?" },
  { key: "routine", question: "What does a writing day look like for you?" },
  { key: "advice", question: "What would you tell someone starting their first LitRPG?" },
  { key: "fun", question: "If you were isekai'd into your own book, how long would you survive?" },
] as const;
export type InterviewKey = (typeof INTERVIEW_QUESTIONS)[number]["key"];
export const MIN_INTERVIEW_ANSWERS = 6;
const KEYS: ReadonlySet<string> = new Set(INTERVIEW_QUESTIONS.map((q) => q.key));

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Invite verified authors whose dated release is 21–35 days out (`interviews.invite`). One
 * invitation per author and book, ever.
 */
export async function inviteDueInterviews(db: Db, now = new Date(), limit = 20): Promise<number> {
  const from = day(new Date(now.getTime() + 21 * 86_400_000));
  const to = day(new Date(now.getTime() + 35 * 86_400_000));
  const due = await db
    .selectDistinct({
      authorId: bookAuthors.authorId,
      bookId: books.id,
      title: books.title,
      date: releases.date,
    })
    .from(releases)
    .innerJoin(books, eq(books.id, releases.bookId))
    .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(
      and(
        eq(books.visibility, "published"),
        gte(releases.date, from),
        lte(releases.date, to),
        eq(releases.datePrecision, "day"),
        inArray(releases.kind, ["ebook", "audio", "print"]),
        inArray(authors.trustLevel, ["T1", "T2"]),
        sql`exists (select 1 from author_members m where m.author_id = ${bookAuthors.authorId} and m.role = 'owner')`,
        sql`not exists (select 1 from interview_responses i where i.author_id = ${bookAuthors.authorId} and i.book_id = ${books.id})`,
      ),
    )
    .limit(limit);
  let invited = 0;
  for (const d of due) {
    const rows = await db
      .insert(interviewResponses)
      .values({
        id: ulid(),
        authorId: d.authorId,
        bookId: d.bookId,
        status: "invited",
        releaseDate: d.date,
        invitedAt: nowIso(now),
      })
      .onConflictDoNothing()
      .returning({ id: interviewResponses.id });
    if (!rows[0]) continue;
    await notifyAuthor(db, {
      authorId: d.authorId,
      kind: "interview_invite",
      payload: { interviewId: rows[0].id, title: d.title, releaseDate: d.date },
    });
    invited++;
  }
  return invited;
}

export class InterviewError extends Error {}

/** Save answers (in the author's words, trimmed). Submitting with enough answers queues formatting. */
export async function saveInterviewAnswers(
  db: Db,
  interviewId: string,
  userId: string,
  raw: Record<string, string>,
  opts: { submit: boolean; priority: number },
): Promise<"saved" | "submitted"> {
  const [row] = await db.select().from(interviewResponses).where(eq(interviewResponses.id, interviewId));
  if (!row || !["invited", "answered"].includes(row.status))
    throw new InterviewError("this interview can't be edited any more");
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw))
    if (KEYS.has(k) && v.trim()) answers[k] = v.replace(/\r\n?/g, "\n").trim().slice(0, 3_000);
  if (opts.submit && Object.keys(answers).length < MIN_INTERVIEW_ANSWERS)
    throw new InterviewError(`answer at least ${MIN_INTERVIEW_ANSWERS} questions`);
  await db
    .update(interviewResponses)
    .set({
      answers,
      userId,
      status: opts.submit ? "answered" : row.status,
      ...(opts.submit ? { answeredAt: nowIso() } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(interviewResponses.id, interviewId));
  if (!opts.submit) return "saved";
  await enqueue(db, [
    { kind: "interview_format", subjectType: "interview", subjectId: interviewId, priority: opts.priority },
  ]);
  return "submitted";
}

export interface InterviewFormat {
  headline: string;
  intro: string;
  order: string[];
  fixes?: Record<string, string>;
}

/** The post text: the intro, then each chosen question and the author's answer (typos fixed). */
export function interviewMarkdown(
  f: InterviewFormat,
  answers: Record<string, string>,
  bookId: string,
): string {
  const parts = [f.intro, `[[book:${bookId}]]`];
  for (const key of f.order) {
    const q = INTERVIEW_QUESTIONS.find((x) => x.key === key);
    const answer = f.fixes?.[key] ?? answers[key];
    if (!q || !answer) continue;
    parts.push(`## ${q.question}`, answer);
  }
  return parts.join("\n\n");
}

/** The author approves the formatted interview: it becomes a post that waits for its slot. */
export async function approveInterview(
  db: Db,
  interviewId: string,
  userId: string,
  env: RenderEnv,
  settings: Pick<Settings, "blog.guest_review_days">,
  now = new Date(),
): Promise<string> {
  const [row] = await db.select().from(interviewResponses).where(eq(interviewResponses.id, interviewId));
  if (row?.status !== "formatted" || !row.formatted) throw new InterviewError("nothing to approve yet");
  const f = row.formatted as unknown as InterviewFormat;
  const [a] = await db.select({ name: authors.name }).from(authors).where(eq(authors.id, row.authorId));
  const post = await createPost(
    db,
    {
      type: "interview",
      title: f.headline,
      dek: `${a?.name ?? "The author"} on their new book, in their own words.`,
      bodyMd: interviewMarkdown(f, row.answers, row.bookId),
      bylineAuthorId: row.authorId,
      status: "in_review",
      aiInvolvement: "assisted",
      disclosure: "The answers are the author's own. We chose the order and wrote the headline and intro",
      genKey: `interview:${row.id}`,
      createdBy: userId,
    },
    env,
  );
  await db
    .update(interviewResponses)
    .set({ status: "approved", approvedAt: nowIso(now), postId: post.id, updatedAt: nowIso(now) })
    .where(eq(interviewResponses.id, interviewId));
  await openInboxItem(db, {
    type: "post_review",
    title: `Interview ready: "${f.headline}"`,
    subjectType: "post",
    subjectId: post.id,
    priority: 45,
    payload: { postId: post.id, title: f.headline, authorId: row.authorId },
    aiRecommendation: "approve",
    aiSummary: "The author approved it. It takes the next guest slot unless you reject it.",
    defaultAction: "approve",
    defaultActionAt: new Date(now.getTime() + settings["blog.guest_review_days"] * 86_400_000).toISOString(),
    dedupeKey: `post_review:${post.id}`,
  });
  return post.id;
}

/** Interviews for an author's profiles, newest first (the dashboard). */
export async function interviewsFor(db: Db, authorIds: string[]) {
  if (authorIds.length === 0) return [];
  return db
    .select({
      id: interviewResponses.id,
      authorId: interviewResponses.authorId,
      bookId: interviewResponses.bookId,
      title: books.title,
      status: interviewResponses.status,
      releaseDate: interviewResponses.releaseDate,
      answers: interviewResponses.answers,
      formatted: interviewResponses.formatted,
      postId: interviewResponses.postId,
    })
    .from(interviewResponses)
    .innerJoin(books, eq(books.id, interviewResponses.bookId))
    .where(inArray(interviewResponses.authorId, authorIds))
    .orderBy(sql`${interviewResponses.createdAt} desc`)
    .limit(20);
}
