// The owner's view of author profiles (DESIGN §8.5): who manages them, how they verified, and the
// two levers the owner holds: the trust level (§2.2, overridable) and the profile's official links,
// which automated verification trusts (§10.2). Both are audited.

import { and, asc, count, eq, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { appendAudit } from "../audit";
import { nameKey } from "../catalog/normalize";
import type { Db } from "../db";
import { authorMembers, authors, TRUST_LEVELS } from "../db/schema";
import type { TrustLevel } from "../policy";
import { nowIso } from "../time";

export interface AuthorListFilters {
  q?: string;
  claimed?: boolean;
  verified?: boolean;
}

export async function listAuthors(db: Db, f: AuthorListFilters, limit = 50, offset = 0) {
  const key = f.q ? nameKey(f.q).replace(/[%_]/g, "") : "";
  const where = and(
    isNull(authors.redirectTo),
    key ? like(authors.nameKey, `%${key}%`) : undefined,
    f.claimed === undefined
      ? undefined
      : f.claimed
        ? sql`exists (select 1 from author_members am where am.author_id = "authors"."id")`
        : sql`not exists (select 1 from author_members am where am.author_id = "authors"."id")`,
    f.verified === undefined
      ? undefined
      : f.verified
        ? isNotNull(authors.verifiedAt)
        : isNull(authors.verifiedAt),
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: authors.id,
        slug: authors.slug,
        name: authors.name,
        trust: authors.trustLevel,
        verifiedAt: authors.verifiedAt,
        members: sql<number>`(select count(*) from author_members am where am.author_id = "authors"."id")`,
        books: sql<number>`(select count(*) from book_authors ba where ba.author_id = "authors"."id")`,
      })
      .from(authors)
      .where(where)
      .orderBy(asc(authors.name))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(authors).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, members: Number(r.members), books: Number(r.books) })),
    total: total?.n ?? 0,
  };
}

export async function setTrustLevel(
  db: Db,
  authorId: string,
  level: TrustLevel,
  adminId: string,
): Promise<boolean> {
  if (!TRUST_LEVELS.includes(level)) return false;
  const [a] = await db.select({ trust: authors.trustLevel }).from(authors).where(eq(authors.id, authorId));
  if (!a || a.trust === level) return false;
  await db.update(authors).set({ trustLevel: level, updatedAt: nowIso() }).where(eq(authors.id, authorId));
  await appendAudit(db, {
    actor: { type: "admin", id: adminId },
    action: "author.trust",
    subjectType: "author",
    subjectId: authorId,
    diff: { from: a.trust, to: level, undo: { kind: "author_trust", authorId, to: a.trust } },
  });
  return true;
}

/** The profile's official links: https only, at most 10. These are what verification trusts. */
export async function setOfficialLinks(
  db: Db,
  authorId: string,
  raw: string[],
  adminId: string,
): Promise<string[]> {
  const links = [
    ...new Set(raw.map((l) => l.trim()).filter((l) => /^https:\/\/[^\s]{4,500}$/.test(l))),
  ].slice(0, 10);
  const [a] = await db.select({ links: authors.links }).from(authors).where(eq(authors.id, authorId));
  if (!a) return [];
  await db.update(authors).set({ links, updatedAt: nowIso() }).where(eq(authors.id, authorId));
  await appendAudit(db, {
    actor: { type: "admin", id: adminId },
    action: "author.links",
    subjectType: "author",
    subjectId: authorId,
    diff: { from: a.links, to: links },
  });
  return links;
}

export async function removeMemberAsAdmin(
  db: Db,
  authorId: string,
  userId: string,
  adminId: string,
): Promise<void> {
  await db
    .delete(authorMembers)
    .where(and(eq(authorMembers.authorId, authorId), eq(authorMembers.userId, userId)));
  await appendAudit(db, {
    actor: { type: "admin", id: adminId },
    action: "author.member_remove",
    subjectType: "author",
    subjectId: authorId,
    diff: { userId },
  });
}

/** An author by id or slug, for console forms. */
export async function findAuthorRef(
  db: Db,
  ref: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  if (!ref) return null;
  const [row] = await db
    .select({ id: authors.id, name: authors.name, slug: authors.slug })
    .from(authors)
    .where(or(eq(authors.id, ref), eq(authors.slug, ref)))
    .limit(1);
  return row ?? null;
}
