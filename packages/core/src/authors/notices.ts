// The author notice outbox (see `author_notices`): decisions and team changes are recorded here by
// whichever Worker made them, and the jobs Worker emails them within minutes.

import { and, asc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db";
import { type AuthorNoticeKind, authorMembers, authorNotices, authors, users } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export async function notifyAuthor(
  db: Db,
  notice: {
    authorId: string;
    userId?: string | null;
    kind: AuthorNoticeKind;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(authorNotices).values({
    id: ulid(),
    authorId: notice.authorId,
    userId: notice.userId ?? null,
    kind: notice.kind,
    payload: notice.payload ?? {},
  });
}

export async function pendingNotices(db: Db, limit = 50) {
  return db
    .select({
      id: authorNotices.id,
      authorId: authorNotices.authorId,
      authorName: authors.name,
      userId: authorNotices.userId,
      kind: authorNotices.kind,
      payload: authorNotices.payload,
    })
    .from(authorNotices)
    .innerJoin(authors, eq(authors.id, authorNotices.authorId))
    .where(isNull(authorNotices.sentAt))
    .orderBy(asc(authorNotices.createdAt))
    .limit(limit);
}

/** Who gets a notice: its user, or else the profile's owners (active accounts only). */
export async function noticeRecipients(
  db: Db,
  n: { authorId: string; userId: string | null },
): Promise<{ userId: string; email: string }[]> {
  if (n.userId) {
    const rows = await db
      .select({ userId: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.id, n.userId), eq(users.state, "active")));
    return rows;
  }
  return db
    .select({ userId: users.id, email: users.email })
    .from(authorMembers)
    .innerJoin(users, eq(users.id, authorMembers.userId))
    .where(
      and(eq(authorMembers.authorId, n.authorId), eq(authorMembers.role, "owner"), eq(users.state, "active")),
    );
}

export async function markNoticeSent(db: Db, id: string, now = new Date()): Promise<void> {
  await db
    .update(authorNotices)
    .set({ sentAt: nowIso(now) })
    .where(eq(authorNotices.id, id));
}

export async function purgeSentNotices(db: Db, now = new Date(), days = 30): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = await db
    .delete(authorNotices)
    .where(lt(authorNotices.sentAt, cutoff))
    .returning({ id: authorNotices.id });
  return rows.length;
}
