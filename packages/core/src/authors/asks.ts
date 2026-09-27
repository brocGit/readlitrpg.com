// "Still on for Oct 12?" (DESIGN §7.7): 14 and 3 days before a dated release, the book's owners get
// signed one-click links to confirm it, give a new date, or say it's delayed. The link names the ask
// and the member, expires in 21 days, and an answered ask takes no more changes.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { setRelease } from "../catalog/releases";
import type { Db } from "../db";
import { authorMembers, bookAuthors, books, releaseAsks, releases } from "../db/schema";
import { ulid } from "../ids";
import type { TrustLevel } from "../policy";
import { type LinkKeys, signLink, verifyLink } from "../readers/links";
import type { Settings } from "../settings";
import { nowIso } from "../time";
import { editBook } from "./edits";

export const ASK_LINK_DAYS = 21;
const STAGES = [
  { stage: "t14", days: 14 },
  { stage: "t3", days: 3 },
] as const;

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);

export interface DueAsk {
  releaseId: string;
  bookId: string;
  title: string;
  slug: string;
  kind: string;
  date: string;
  stage: "t14" | "t3";
}

/** Published books' dated releases exactly 14 or 3 days out, whose authors have members, not yet asked. */
export async function dueReleaseAsks(db: Db, now = new Date()): Promise<DueAsk[]> {
  const out: DueAsk[] = [];
  for (const { stage, days } of STAGES) {
    const date = addDays(now, days);
    const rows = await db
      .select({
        releaseId: releases.id,
        bookId: releases.bookId,
        kind: releases.kind,
        date: releases.date,
        title: books.title,
        slug: books.slug,
      })
      .from(releases)
      .innerJoin(books, eq(books.id, releases.bookId))
      .where(
        and(
          eq(releases.date, date),
          eq(releases.datePrecision, "day"),
          inArray(releases.status, ["scheduled", "confirmed", "slipped"]),
          eq(books.visibility, "published"),
          isNull(books.redirectTo),
        ),
      )
      .limit(500);
    for (const r of rows) {
      const [asked] = await db
        .select({ id: releaseAsks.id })
        .from(releaseAsks)
        .where(
          and(
            eq(releaseAsks.releaseId, r.releaseId),
            eq(releaseAsks.stage, stage),
            eq(releaseAsks.date, date),
          ),
        );
      if (!asked) out.push({ ...r, date, stage });
    }
  }
  return out;
}

/** Owners who should get the ask: owners of the book's profiles. */
export async function askRecipients(db: Db, bookId: string): Promise<{ userId: string; authorId: string }[]> {
  return db
    .selectDistinct({ userId: authorMembers.userId, authorId: authorMembers.authorId })
    .from(bookAuthors)
    .innerJoin(authorMembers, eq(authorMembers.authorId, bookAuthors.authorId))
    .where(and(eq(bookAuthors.bookId, bookId), eq(authorMembers.role, "owner")));
}

/** Record the ask (once per release, stage and date). Null if another run already did. */
export async function createAsk(db: Db, a: DueAsk, now = new Date()): Promise<string | null> {
  const id = ulid();
  const rows = await db
    .insert(releaseAsks)
    .values({
      id,
      releaseId: a.releaseId,
      bookId: a.bookId,
      stage: a.stage,
      date: a.date,
      sentAt: nowIso(now),
    })
    .onConflictDoNothing()
    .returning({ id: releaseAsks.id });
  return rows[0]?.id ?? null;
}

export async function askUrl(
  keys: LinkKeys,
  origin: string,
  askId: string,
  userId: string,
  now = Date.now(),
) {
  const token = await signLink(keys, "release", [askId, userId], now + ASK_LINK_DAYS * 86_400_000);
  return `${origin.replace(/\/$/, "")}/dashboard/release/${token}`;
}

export interface OpenAsk {
  askId: string;
  userId: string;
  answered: string | null;
  releaseId: string;
  bookId: string;
  title: string;
  slug: string;
  kind: string;
  date: string;
}

export async function readAsk(db: Db, keys: LinkKeys, token: string): Promise<OpenAsk | null> {
  const data = await verifyLink(keys, token, "release");
  if (!data) return null;
  const [askId = "", userId = ""] = data;
  const [row] = await db
    .select({
      askId: releaseAsks.id,
      answered: releaseAsks.answer,
      releaseId: releaseAsks.releaseId,
      bookId: releaseAsks.bookId,
      title: books.title,
      slug: books.slug,
      kind: releases.kind,
      date: releaseAsks.date,
    })
    .from(releaseAsks)
    .innerJoin(books, eq(books.id, releaseAsks.bookId))
    .innerJoin(releases, eq(releases.id, releaseAsks.releaseId))
    .where(eq(releaseAsks.id, askId));
  return row ? { ...row, userId } : null;
}

export type AskAnswer = "confirmed" | "new_date" | "delayed";

/**
 * Answer an ask as the member it was sent to (who must still manage the book). Single use: the ask
 * is claimed with a conditional update first. A new date follows the same rules as any author edit,
 * so a change inside 72 hours of release goes to the Owner Inbox.
 */
export async function answerAsk(
  db: Db,
  ask: OpenAsk,
  input: {
    answer: AskAnswer;
    newDate?: string;
    trust: TrustLevel;
    authorId: string;
    settings: Settings;
    now?: Date;
  },
): Promise<"done" | "queued" | "already"> {
  const now = input.now ?? new Date();
  const claimed = await db
    .update(releaseAsks)
    .set({ answer: input.answer, answeredBy: ask.userId, answeredAt: nowIso(now) })
    .where(and(eq(releaseAsks.id, ask.askId), isNull(releaseAsks.answeredAt)))
    .returning({ id: releaseAsks.id });
  if (claimed.length === 0) return "already";
  if (input.answer === "confirmed") {
    await setRelease(db, ask.bookId, { kind: ask.kind as never, date: ask.date }, "author", now);
    return "done";
  }
  const date = input.answer === "delayed" ? "TBA" : (input.newDate ?? "");
  const result = await editBook(
    db,
    ask.bookId,
    { release: { kind: ask.kind, date } },
    { userId: ask.userId, authorId: input.authorId, trust: input.trust, settings: input.settings, now },
  );
  return result.queued.length ? "queued" : "done";
}
