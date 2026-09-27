// Read models for the console's editorial pages (DESIGN §8.5 "Automation": editorial queue and run
// history). Proposal payloads are untrusted text: pages render them escaped, never as HTML.

import type { Db } from "@rlr/core/db";
import { bookScores, editorialProposals, editorialQueue, type ProposalStatus } from "@rlr/core/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

export type ProposalRow = typeof editorialProposals.$inferSelect;

export async function proposalsByStatus(
  db: Db,
  statuses: ProposalStatus[],
  limit = 100,
): Promise<ProposalRow[]> {
  return db
    .select()
    .from(editorialProposals)
    .where(inArray(editorialProposals.status, statuses))
    .orderBy(desc(editorialProposals.createdAt))
    .limit(limit);
}

export async function recentProposals(db: Db, limit = 50): Promise<ProposalRow[]> {
  return db.select().from(editorialProposals).orderBy(desc(editorialProposals.createdAt)).limit(limit);
}

export async function runProposals(db: Db, runId: string): Promise<ProposalRow[]> {
  return db
    .select()
    .from(editorialProposals)
    .where(eq(editorialProposals.runId, runId))
    .orderBy(desc(editorialProposals.createdAt))
    .limit(500);
}

export async function bookProposals(db: Db, bookId: string, limit = 20): Promise<ProposalRow[]> {
  return db
    .select()
    .from(editorialProposals)
    .where(and(eq(editorialProposals.subjectType, "book"), eq(editorialProposals.subjectId, bookId)))
    .orderBy(desc(editorialProposals.createdAt))
    .limit(limit);
}

export async function openQueueItemsFor(db: Db, bookId: string) {
  return db
    .select({ id: editorialQueue.id, kind: editorialQueue.kind, status: editorialQueue.status })
    .from(editorialQueue)
    .where(and(eq(editorialQueue.subjectId, bookId), inArray(editorialQueue.status, ["queued", "claimed"])));
}

export async function bookScoreRows(db: Db, bookId: string) {
  return db
    .select()
    .from(bookScores)
    .where(eq(bookScores.bookId, bookId))
    .orderBy(bookScores.kind, bookScores.key);
}

/** A one-line description of what a proposal said, for tables. */
export function proposalSummary(p: ProposalRow): string {
  const payload = (p.payload ?? {}) as Record<string, unknown>;
  switch (p.kind) {
    case "classify": {
      const tags = Array.isArray(payload.tags) ? payload.tags.length : 0;
      return `${String(payload.primary_genre ?? "?")}, ${tags} tags, in scope: ${String(payload.in_scope ?? "?")}`;
    }
    case "dedupe":
      return `${String(payload.verdict ?? "?")} (${String(payload.confidence ?? "?")})`;
    case "research": {
      const sources = Array.isArray(payload.sources) ? payload.sources.length : 0;
      return `${String(payload.verdict ?? "?")}, ${sources} source${sources === 1 ? "" : "s"}`;
    }
    default:
      return String(payload.verdict ?? "?");
  }
}

/** Where to see the thing a proposal is about. */
export function subjectHref(p: Pick<ProposalRow, "subjectType" | "subjectId">): string | null {
  if (!p.subjectId) return null;
  if (p.subjectType === "book") return `/catalog/books/${p.subjectId}`;
  if (p.subjectType === "inbox_item") return "/inbox";
  return null;
}

/** Only same-site paths are followed after a form post. */
export function safeBack(path: string | undefined, fallback: string): string {
  return path && /^\/(?!\/)[\w\-/.?=&%]*$/.test(path) ? path : fallback;
}
