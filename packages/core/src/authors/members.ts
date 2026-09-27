// Who manages which author profile (DESIGN §2.1, §10.1, §10.2). A reader claims an unclaimed
// profile or creates a new one and becomes its owner. A profile that already has members goes to
// the Owner Inbox instead (claim_conflict). Owners invite editors by a signed email link.

import { and, asc, count, eq, isNull, like, sql } from "drizzle-orm";
import { cleanText, nameKey } from "../catalog/normalize";
import { uniqueSlug } from "../catalog/resolve";
import type { Db } from "../db";
import { authorMembers, authors, bookAuthors, type MemberRole, users } from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import type { AuthorMembership, TrustLevel } from "../policy";
import { type LinkKeys, signLink, verifyLink } from "../readers/links";
import { nowIso } from "../time";

export class MembershipError extends Error {}

/** The memberships the policy module needs (`Actor.authors`). Merged-away profiles are skipped. */
export async function membershipsFor(db: Db, userId: string): Promise<AuthorMembership[]> {
  const rows = await db
    .select({ authorId: authorMembers.authorId, role: authorMembers.role, trust: authors.trustLevel })
    .from(authorMembers)
    .innerJoin(authors, eq(authors.id, authorMembers.authorId))
    .where(and(eq(authorMembers.userId, userId), isNull(authors.redirectTo)));
  return rows.map((r) => ({ authorId: r.authorId, role: r.role, trust: r.trust as TrustLevel }));
}

export interface ProfileSummary {
  id: string;
  slug: string;
  name: string;
  role: MemberRole;
  trust: TrustLevel;
  verifiedAt: string | null;
  books: number;
}

export async function profilesFor(db: Db, userId: string): Promise<ProfileSummary[]> {
  const rows = await db
    .select({
      id: authors.id,
      slug: authors.slug,
      name: authors.name,
      role: authorMembers.role,
      trust: authors.trustLevel,
      verifiedAt: authors.verifiedAt,
      books: sql<number>`(select count(*) from book_authors ba where ba.author_id = ${authors.id})`,
    })
    .from(authorMembers)
    .innerJoin(authors, eq(authors.id, authorMembers.authorId))
    .where(and(eq(authorMembers.userId, userId), isNull(authors.redirectTo)))
    .orderBy(asc(authors.name));
  return rows.map((r) => ({ ...r, trust: r.trust as TrustLevel, books: Number(r.books) }));
}

export interface ProfileMatch {
  id: string;
  slug: string;
  name: string;
  books: number;
  claimed: boolean;
}

/** Profiles a new author might be (§10.1 step 2). Says whether one is claimed, never by whom. */
export async function searchProfiles(db: Db, query: string, limit = 10): Promise<ProfileMatch[]> {
  const key = nameKey(query);
  if (key.length < 2) return [];
  const rows = await db
    .select({
      id: authors.id,
      slug: authors.slug,
      name: authors.name,
      books: sql<number>`(select count(*) from book_authors ba where ba.author_id = ${authors.id})`,
      claimed: sql<number>`exists (select 1 from author_members am where am.author_id = ${authors.id})`,
    })
    .from(authors)
    .where(and(like(authors.nameKey, `%${key.replace(/[%_]/g, "")}%`), isNull(authors.redirectTo)))
    .orderBy(asc(authors.name))
    .limit(limit);
  return rows.map((r) => ({ ...r, books: Number(r.books), claimed: Boolean(r.claimed) }));
}

async function memberCount(db: Db, authorId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(authorMembers)
    .where(eq(authorMembers.authorId, authorId));
  return row?.n ?? 0;
}

export async function roleOf(db: Db, authorId: string, userId: string): Promise<MemberRole | null> {
  const [row] = await db
    .select({ role: authorMembers.role })
    .from(authorMembers)
    .where(and(eq(authorMembers.authorId, authorId), eq(authorMembers.userId, userId)));
  return row?.role ?? null;
}

export type ClaimResult = { status: "claimed" | "already" | "conflict" };

/**
 * Claim an existing profile. Unclaimed: the claimant becomes its owner at T0 (unverified), so
 * everything they submit is reviewed until they verify. Claimed already: the Owner Inbox decides.
 */
export async function claimProfile(db: Db, userId: string, authorId: string): Promise<ClaimResult> {
  const [author] = await db
    .select({ id: authors.id, name: authors.name, redirectTo: authors.redirectTo })
    .from(authors)
    .where(eq(authors.id, authorId));
  if (!author || author.redirectTo) throw new MembershipError("no such author profile");
  if (await roleOf(db, authorId, userId)) return { status: "already" };
  if ((await memberCount(db, authorId)) > 0) {
    await openInboxItem(db, {
      type: "claim_conflict",
      title: `Second claim on the author profile "${author.name}"`,
      subjectType: "author",
      subjectId: authorId,
      priority: 70,
      payload: { authorId, userId, name: author.name },
      dedupeKey: `claim:${authorId}:${userId}`,
    });
    return { status: "conflict" };
  }
  await db
    .insert(authorMembers)
    .values({ authorId, userId, role: "owner", addedBy: userId })
    .onConflictDoNothing();
  return { status: "claimed" };
}

export type CreateResult = { status: "created"; authorId: string } | { status: "exists"; authorId: string };

/**
 * A new profile for a pen name we don't know yet. If the name is already in the catalog the author
 * is pointed at that profile to claim instead, so books don't split across two profiles.
 */
export async function createProfile(
  db: Db,
  userId: string,
  input: { name: string; bio?: string | null },
): Promise<CreateResult> {
  const name = cleanText(input.name).slice(0, 200);
  const key = nameKey(name);
  if (!key) throw new MembershipError("a pen name needs letters");
  const [existing] = await db
    .select({ id: authors.id })
    .from(authors)
    .where(and(eq(authors.nameKey, key), isNull(authors.redirectTo)))
    .limit(1);
  if (existing) return { status: "exists", authorId: existing.id };
  const id = ulid();
  await db.insert(authors).values({
    id,
    slug: await uniqueSlug(db, authors, name),
    name,
    nameKey: key,
    bio: input.bio ? cleanText(input.bio).slice(0, 2_000) : null,
    origin: "author",
  });
  await db.insert(authorMembers).values({ authorId: id, userId, role: "owner", addedBy: userId });
  return { status: "created", authorId: id };
}

export async function addMember(
  db: Db,
  authorId: string,
  userId: string,
  role: MemberRole,
  addedBy: string | null,
): Promise<boolean> {
  const rows = await db
    .insert(authorMembers)
    .values({ authorId, userId, role, addedBy, createdAt: nowIso() })
    .onConflictDoNothing()
    .returning({ userId: authorMembers.userId });
  return rows.length === 1;
}

/** Owners remove members (themselves included), but a profile always keeps one owner. */
export async function removeMember(
  db: Db,
  authorId: string,
  byUserId: string,
  userId: string,
): Promise<void> {
  if ((await roleOf(db, authorId, byUserId)) !== "owner")
    throw new MembershipError("only an owner can do that");
  const target = await roleOf(db, authorId, userId);
  if (!target) return;
  if (target === "owner") {
    const [owners] = await db
      .select({ n: count() })
      .from(authorMembers)
      .where(and(eq(authorMembers.authorId, authorId), eq(authorMembers.role, "owner")));
    if ((owners?.n ?? 0) <= 1) throw new MembershipError("a profile needs at least one owner");
  }
  await db
    .delete(authorMembers)
    .where(and(eq(authorMembers.authorId, authorId), eq(authorMembers.userId, userId)));
}

export async function membersOf(db: Db, authorId: string) {
  return db
    .select({
      userId: authorMembers.userId,
      email: users.email,
      role: authorMembers.role,
      since: authorMembers.createdAt,
    })
    .from(authorMembers)
    .innerJoin(users, eq(users.id, authorMembers.userId))
    .where(eq(authorMembers.authorId, authorId))
    .orderBy(asc(authorMembers.createdAt));
}

/** Owner emails, for "a member was added" notices and release-date asks. */
export async function ownerEmails(db: Db, authorId: string): Promise<{ userId: string; email: string }[]> {
  return db
    .select({ userId: authorMembers.userId, email: users.email })
    .from(authorMembers)
    .innerJoin(users, eq(users.id, authorMembers.userId))
    .where(
      and(eq(authorMembers.authorId, authorId), eq(authorMembers.role, "owner"), eq(users.state, "active")),
    );
}

// ---------------------------------------------------------------------------------------------
// Team invites (§10.5): a signed link to the invitee's address, valid for 7 days. Accepting needs
// a sign-in with that address, so the link alone grants nothing and reveals no accounts.

export const INVITE_DAYS = 7;

export async function inviteLink(
  keys: LinkKeys,
  origin: string,
  invite: { authorId: string; email: string; role: MemberRole },
  now = Date.now(),
): Promise<string> {
  const token = await signLink(
    keys,
    "invite",
    [invite.authorId, invite.email.trim().toLowerCase(), invite.role],
    now + INVITE_DAYS * 86_400_000,
  );
  return `${origin.replace(/\/$/, "")}/dashboard/invite/${token}`;
}

export interface Invite {
  authorId: string;
  email: string;
  role: MemberRole;
  authorName: string;
}

export async function readInvite(db: Db, keys: LinkKeys, token: string): Promise<Invite | null> {
  const data = await verifyLink(keys, token, "invite");
  if (!data) return null;
  const [authorId = "", email = "", role = ""] = data;
  if (role !== "owner" && role !== "editor") return null;
  const [author] = await db
    .select({ name: authors.name })
    .from(authors)
    .where(and(eq(authors.id, authorId), isNull(authors.redirectTo)));
  return author ? { authorId, email, role, authorName: author.name } : null;
}

export async function acceptInvite(
  db: Db,
  invite: Invite,
  user: { userId: string; email: string },
): Promise<"added" | "already" | "wrong_account"> {
  if (user.email.trim().toLowerCase() !== invite.email) return "wrong_account";
  return (await addMember(db, invite.authorId, user.userId, invite.role, null)) ? "added" : "already";
}

/** Profiles books are credited to, for ownership checks on a book (`Resource` of type "book"). */
export async function bookAuthorIds(db: Db, bookId: string): Promise<string[]> {
  const rows = await db
    .select({ id: bookAuthors.authorId })
    .from(bookAuthors)
    .where(eq(bookAuthors.bookId, bookId));
  return rows.map((r) => r.id);
}
