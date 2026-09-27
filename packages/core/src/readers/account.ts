// Account rights (DESIGN §9.8, §16.3): export everything we hold about a reader as JSON, and delete
// an account at once. Deletion is a hard delete of personal data; only a hash of the address stays
// on the suppression list so it is never mailed again.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import {
  appraisals,
  authorMembers,
  authorNotices,
  authorPastes,
  authorSubmissions,
  authors,
  bookMarks,
  books,
  dataExports,
  emailConsents,
  emailSends,
  emailSequences,
  feedTokens,
  follows,
  libraryImportRows,
  libraryImports,
  passkeys,
  quizTakes,
  readerProfiles,
  releaseAsks,
  savedQueries,
  sessions,
  users,
  verificationRequests,
  verifications,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { followsFor, marksFor, savedFor } from "./activity";
import { consentsFor, suppress } from "./consent";
import { getReaderProfile } from "./profile";

export const EXPORT_TTL_DAYS = 7;

export async function requestExport(db: Db, userId: string): Promise<{ id: string; fresh: boolean }> {
  const [open] = await db
    .select({ id: dataExports.id })
    .from(dataExports)
    .where(and(eq(dataExports.userId, userId), eq(dataExports.status, "queued")));
  if (open) return { id: open.id, fresh: false };
  const id = ulid();
  await db.insert(dataExports).values({ id, userId, status: "queued", createdAt: nowIso() });
  return { id, fresh: true };
}

/** Everything personal we hold, in one JSON document. */
export async function buildExport(db: Db, userId: string) {
  const [user] = await db
    .select({
      email: users.email,
      name: users.name,
      handle: users.handle,
      createdAt: users.createdAt,
      state: users.state,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const [profile, followList, marks, saved, consents, takes, appraised, keys, imports] = await Promise.all([
    getReaderProfile(db, userId),
    followsFor(db, userId),
    marksFor(db, userId),
    savedFor(db, userId),
    consentsFor(db, userId),
    db
      .select({
        quiz: quizTakes.quizSlug,
        outcome: quizTakes.outcomeKey,
        answers: quizTakes.answers,
        at: quizTakes.createdAt,
      })
      .from(quizTakes)
      .where(eq(quizTakes.userId, userId)),
    db
      .select({ book: books.slug, key: appraisals.key, value: appraisals.value, at: appraisals.createdAt })
      .from(appraisals)
      .innerJoin(books, eq(books.id, appraisals.bookId))
      .where(eq(appraisals.userId, userId)),
    db
      .select({ name: passkeys.name, createdAt: passkeys.createdAt })
      .from(passkeys)
      .where(eq(passkeys.userId, userId)),
    db
      .select({
        source: libraryImports.source,
        total: libraryImports.total,
        matched: libraryImports.matched,
        at: libraryImports.createdAt,
      })
      .from(libraryImports)
      .where(eq(libraryImports.userId, userId)),
  ]);
  return {
    exportedAt: nowIso(),
    account: {
      email: user.email,
      displayName: user.name,
      handle: user.handle,
      createdAt: new Date(user.createdAt).toISOString(),
      state: user.state,
    },
    tasteProfile: profile,
    follows: followList.map((f) => ({
      type: f.type,
      name: f.name,
      page: f.path,
      notify: f.notify,
      since: f.createdAt,
    })),
    bookMarks: marks,
    savedMatchesAndSearches: saved.map((s) => ({
      kind: s.kind,
      name: s.name,
      params: s.params,
      alert: s.alert,
      createdAt: s.createdAt,
    })),
    emailConsents: consents,
    quizTakes: takes,
    appraisals: appraised,
    passkeys: keys.map((k) => ({
      name: k.name,
      createdAt: k.createdAt ? new Date(k.createdAt).toISOString() : null,
    })),
    libraryImports: imports,
    authorProfiles: await db
      .select({
        name: authors.name,
        slug: authors.slug,
        role: authorMembers.role,
        since: authorMembers.createdAt,
      })
      .from(authorMembers)
      .innerJoin(authors, eq(authors.id, authorMembers.authorId))
      .where(eq(authorMembers.userId, userId)),
    authorSubmissions: (
      await db
        .select({
          status: authorSubmissions.status,
          payload: authorSubmissions.payload,
          at: authorSubmissions.createdAt,
        })
        .from(authorSubmissions)
        .where(eq(authorSubmissions.userId, userId))
    ).map((s) => ({ status: s.status, title: (s.payload as { title?: string }).title ?? null, at: s.at })),
  };
}

/**
 * Delete an account now. Sessions, passkeys and linked accounts go with the user row (cascade);
 * everything else we hold for this person is deleted here. The send log keeps its rows for
 * deliverability stats, without the user. Returns the export objects to remove from storage.
 */
export async function deleteAccount(
  db: Db,
  userId: string,
): Promise<{ deleted: boolean; exportKeys: string[] }> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) return { deleted: false, exportKeys: [] };
  const exports = await db
    .select({ key: dataExports.objectKey })
    .from(dataExports)
    .where(eq(dataExports.userId, userId));
  const importIds = (
    await db.select({ id: libraryImports.id }).from(libraryImports).where(eq(libraryImports.userId, userId))
  ).map((i) => i.id);
  await suppress(db, user.email, "account_deleted");
  await db.batch([
    db.delete(follows).where(eq(follows.userId, userId)),
    db.delete(bookMarks).where(eq(bookMarks.userId, userId)),
    db.delete(savedQueries).where(eq(savedQueries.userId, userId)),
    db.delete(feedTokens).where(eq(feedTokens.userId, userId)),
    db.delete(readerProfiles).where(eq(readerProfiles.userId, userId)),
    db.delete(emailConsents).where(eq(emailConsents.userId, userId)),
    db.delete(emailSequences).where(eq(emailSequences.userId, userId)),
    db.delete(dataExports).where(eq(dataExports.userId, userId)),
    db.delete(quizTakes).where(eq(quizTakes.userId, userId)),
    db.delete(appraisals).where(eq(appraisals.userId, userId)),
    db.update(emailSends).set({ userId: null }).where(eq(emailSends.userId, userId)),
    // Author profiles and their books are public catalog data and stay; the person's link to them
    // goes. Submissions stay with the profile, without the person (M6).
    db.delete(authorMembers).where(eq(authorMembers.userId, userId)),
    db.delete(verificationRequests).where(eq(verificationRequests.userId, userId)),
    db.delete(authorPastes).where(eq(authorPastes.userId, userId)),
    db.delete(authorNotices).where(eq(authorNotices.userId, userId)),
    db.update(authorSubmissions).set({ userId: null }).where(eq(authorSubmissions.userId, userId)),
    db.update(releaseAsks).set({ answeredBy: null }).where(eq(releaseAsks.answeredBy, userId)),
    db.delete(verifications).where(eq(verifications.identifier, user.email)),
    db.delete(sessions).where(eq(sessions.userId, userId)),
    db.delete(users).where(eq(users.id, userId)),
  ]);
  for (let i = 0; i < importIds.length; i += 90) {
    const part = importIds.slice(i, i + 90);
    await db.delete(libraryImportRows).where(inArray(libraryImportRows.importId, part));
    await db.delete(libraryImports).where(inArray(libraryImports.id, part));
  }
  return { deleted: true, exportKeys: exports.map((e) => e.key).filter((k): k is string => Boolean(k)) };
}
