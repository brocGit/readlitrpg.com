// What approving or rejecting an author item in the Owner Inbox does (DESIGN §8.2). The same
// handlers run for the owner's click in the console and for default actions on the heartbeat.

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { authorSubmissions, authors, books } from "../db/schema";
import type { InboxHandler } from "../inbox";
import type { TrustLevel } from "../policy";
import type { UndoSpec } from "../undo";
import { applyEdit, editPatchSchema } from "./edits";
import { addMember } from "./members";
import { notifyAuthor } from "./notices";
import { applySubmission, rejectSubmission } from "./submit";
import { markVerified, rejectVerification } from "./verify";

const str = (p: unknown, key: string): string =>
  typeof p === "object" && p !== null && typeof (p as Record<string, unknown>)[key] === "string"
    ? ((p as Record<string, unknown>)[key] as string)
    : "";

/** Submission items share types with catalog items (possible_duplicate, scope_check): check the subject. */
const submissionHandler: InboxHandler = {
  async approve(db, item, ctx) {
    if (item.subjectType !== "submission" || !item.subjectId) return;
    const [sub] = await db.select().from(authorSubmissions).where(eq(authorSubmissions.id, item.subjectId));
    if (sub?.status !== "in_review") return;
    const bookId = await applySubmission(db, sub.id, { settings: ctx.settings, now: ctx.now });
    const [book] = await db
      .select({ slug: books.slug, title: books.title, visibility: books.visibility })
      .from(books)
      .where(eq(books.id, bookId));
    await notifyAuthor(db, {
      authorId: sub.authorId,
      userId: sub.userId,
      kind: "listing_published",
      payload: { title: book?.title ?? str(sub.payload, "title"), slug: book?.slug ?? null, bookId },
    });
    // Undo hides the listing again (§8.3: "unpublish a listing").
    return book?.visibility === "published"
      ? ({ kind: "visibility", bookId, to: "hidden" } satisfies UndoSpec)
      : null;
  },
  async reject(db, item, ctx) {
    if (item.subjectType !== "submission" || !item.subjectId) return;
    const [sub] = await db.select().from(authorSubmissions).where(eq(authorSubmissions.id, item.subjectId));
    if (!sub) return;
    const reason = ctx.note?.trim() || "It didn't pass our listing checks.";
    if (await rejectSubmission(db, sub.id, reason, ctx.now))
      await notifyAuthor(db, {
        authorId: sub.authorId,
        userId: sub.userId,
        kind: "listing_rejected",
        payload: { title: str(sub.payload, "title"), reason },
      });
  },
};

async function trustOf(db: Db, authorId: string): Promise<TrustLevel> {
  const [a] = await db.select({ trust: authors.trustLevel }).from(authors).where(eq(authors.id, authorId));
  return (a?.trust ?? "T0") as TrustLevel;
}

export const AUTHOR_INBOX_HANDLERS: Record<string, InboxHandler> = {
  listing_unverified: submissionHandler,
  listing_review: submissionHandler,
  listing_checks_failed: submissionHandler,
  possible_duplicate: submissionHandler,
  scope_check: submissionHandler,

  protected_change: {
    async approve(db, item, ctx) {
      const p = item.payload as Record<string, unknown> | null;
      const bookId = str(p, "bookId");
      const authorId = str(p, "authorId");
      const patch = editPatchSchema.safeParse(p?.patch);
      if (!bookId || !authorId || !patch.success) return;
      // Applied as the author, at their trust level now (they may have verified meanwhile).
      await applyEdit(db, bookId, patch.data, {
        userId: str(p, "userId"),
        authorId,
        trust: await trustOf(db, authorId),
        settings: ctx.settings,
        now: ctx.now,
      });
      await notifyAuthor(db, {
        authorId,
        userId: str(p, "userId") || null,
        kind: "change_approved",
        payload: { bookId, reason: str(p, "reason") },
      });
    },
    async reject(db, item, ctx) {
      const p = item.payload as Record<string, unknown> | null;
      const authorId = str(p, "authorId");
      if (!authorId) return;
      await notifyAuthor(db, {
        authorId,
        userId: str(p, "userId") || null,
        kind: "change_rejected",
        payload: { bookId: str(p, "bookId"), reason: str(p, "reason"), note: ctx.note ?? null },
      });
    },
  },

  verification_manual: {
    async approve(db, item, ctx) {
      const requestId = str(item.payload, "requestId");
      if (requestId && (await markVerified(db, requestId, { type: "admin", id: ctx.decidedBy }, ctx.now)))
        await notifyAuthor(db, { authorId: str(item.payload, "authorId"), kind: "verified" });
    },
    async reject(db, item, ctx) {
      const requestId = str(item.payload, "requestId");
      if (
        requestId &&
        (await rejectVerification(db, requestId, { type: "admin", id: ctx.decidedBy }, ctx.now))
      )
        await notifyAuthor(db, {
          authorId: str(item.payload, "authorId"),
          kind: "verify_rejected",
          payload: { note: ctx.note ?? null },
        });
    },
  },

  claim_conflict: {
    async approve(db, item, ctx) {
      const authorId = str(item.payload, "authorId");
      const userId = str(item.payload, "userId");
      if (!authorId || !userId) return;
      if (await addMember(db, authorId, userId, "owner", ctx.decidedBy)) {
        await notifyAuthor(db, { authorId, userId, kind: "claim_approved" });
        await notifyAuthor(db, { authorId, kind: "member_added", payload: { userId, by: "ReadLitRPG" } });
        return { kind: "member_remove", authorId, userId } satisfies UndoSpec;
      }
      return null;
    },
    async reject(db, item, ctx) {
      const authorId = str(item.payload, "authorId");
      const userId = str(item.payload, "userId");
      if (authorId && userId)
        await notifyAuthor(db, {
          authorId,
          userId,
          kind: "claim_rejected",
          payload: { note: ctx.note ?? null },
        });
    },
  },
};
