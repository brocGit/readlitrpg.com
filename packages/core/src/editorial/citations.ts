// Checking research citations (DESIGN §7.15, §7.12). A research run can misremember or invent a
// source, so a cited confirmation counts only once the server has fetched the page itself and
// found the book's title and an author's name on it. Sites on the do-not-fetch list are never
// fetched (and are refused at push time).

import { and, asc, eq, inArray } from "drizzle-orm";
import { addConfirmation } from "../catalog/confirm";
import { type FieldWrite, writeBookFields } from "../catalog/fields";
import { titleKey } from "../catalog/normalize";
import { CONFIDENCE_VALUES } from "../catalog/provenance";
import type { Db } from "../db";
import { authors, bookAuthors, books, editorialProposals } from "../db/schema";
import { openInboxItem } from "../inbox";
import type { Logger } from "../log";
import { SafeFetchError, safeFetch } from "../net/safe-fetch";
import { nowIso } from "../time";
import type { ResearchProposal } from "./schemas";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Visible text of an HTML page, good enough to look for a title and a name. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

/** Lowercase words only, for phrase matching that ignores punctuation and markup. */
export function matchText(s: string): string {
  return ` ${s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/** Does the page mention the book? The title (or its matching key) and one author's full name. */
export function pageMentions(pageText: string, title: string, authorNames: string[]): boolean {
  const hay = matchText(pageText);
  const titles = [matchText(title), matchText(titleKey(title))]
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  const hasTitle = titles.some((t) => hay.includes(` ${t} `));
  const hasAuthor = authorNames.some((a) => {
    const name = matchText(a).trim();
    return name.length >= 3 && hay.includes(` ${name} `);
  });
  return hasTitle && hasAuthor;
}

export interface CitationCheckOptions {
  limit?: number;
  fetch?: typeof fetch;
  log?: Logger;
}

type Check = { url: string; outcome: "mentions" | "no_mention" | "http_error" | "fetch_error" | "blocked" };

/** Network failures get this many tries before the proposal is marked unverified. */
const MAX_TRIES = 3;

export async function checkPendingCitations(db: Db, opts: CitationCheckOptions = {}): Promise<number> {
  const pending = await db
    .select()
    .from(editorialProposals)
    .where(and(eq(editorialProposals.status, "pending_check"), eq(editorialProposals.kind, "research")))
    .orderBy(asc(editorialProposals.createdAt))
    .limit(opts.limit ?? 10);
  for (const row of pending) {
    const p = row.payload as ResearchProposal;
    const [book] = await db.select().from(books).where(eq(books.id, p.book_id));
    if (!book || book.redirectTo) {
      await settle(db, row.id, "unverified", { reason: "book merged or gone" });
      continue;
    }
    const names = (
      await db
        .select({ name: authors.name })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(eq(bookAuthors.bookId, book.id))
    ).map((a) => a.name);
    const checks: Check[] = [];
    let verified: string | null = null;
    for (const source of p.sources) {
      const check = await checkOne(source.url, book.title, names, p.facts?.title, opts.fetch);
      checks.push(check);
      if (check.outcome === "mentions") {
        verified = source.url;
        break;
      }
    }
    const prior = (row.result as { tries?: number } | null)?.tries ?? 0;
    if (!verified) {
      const onlyNetwork = checks.every((c) => c.outcome === "fetch_error");
      if (onlyNetwork && prior + 1 < MAX_TRIES) {
        await db
          .update(editorialProposals)
          .set({ result: { tries: prior + 1, checks } })
          .where(eq(editorialProposals.id, row.id));
      } else {
        await settle(db, row.id, "unverified", { tries: prior + 1, checks });
      }
      opts.log?.info("citations.unverified", { proposal_id: row.id, book_id: book.id });
      continue;
    }
    const quote = p.sources.find((s) => s.url === verified)?.quote;
    await addConfirmation(db, {
      subjectType: "book",
      subjectId: book.id,
      source: "research",
      sourceRef: verified,
      evidence: { quote: quote ?? null, runId: row.runId, proposalId: row.id, checkedAt: nowIso() },
    });
    let applied: string[] = [];
    let conflictItem: string | null = null;
    if (p.verdict === "confirmed" && p.facts) {
      applied = await applyFacts(db, book.id, book.title, p, row.runId);
    } else if (p.verdict === "conflict") {
      // The record exists but a detail differs: the owner picks, with the checked source attached.
      const opened = await openInboxItem(db, {
        type: "seed_check",
        title: `Research found different details for "${book.title}"`,
        subjectType: "book",
        subjectId: book.id,
        priority: 30,
        aiSummary: p.notes ?? "A cited source disagrees with our record.",
        aiRecommendation: "edit",
        payload: { bookId: book.id, facts: p.facts ?? null, source: verified, proposalId: row.id },
        dedupeKey: `seed_conflict:${book.id}:${row.id}`,
      });
      conflictItem = opened?.id ?? null;
    }
    await settle(db, row.id, "accepted", { tries: prior + 1, checks, verified, applied, conflictItem });
    opts.log?.info("citations.confirmed", { proposal_id: row.id, book_id: book.id });
  }
  return pending.length;
}

async function checkOne(
  url: string,
  title: string,
  authorNames: string[],
  factTitle: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<Check> {
  try {
    const response = await safeFetch(url, {
      allowHosts: ["*"],
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      timeoutMs: 8_000,
      maxBytes: 2_000_000,
      fetch: fetchImpl,
    });
    if (response.status !== 200) return { url, outcome: "http_error" };
    const text = htmlToText(response.text);
    const ok =
      pageMentions(text, title, authorNames) ||
      (factTitle ? pageMentions(text, factTitle, authorNames) : false);
    return { url, outcome: ok ? "mentions" : "no_mention" };
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === "blocked") return { url, outcome: "blocked" };
    return { url, outcome: "fetch_error" };
  }
}

/** Research facts rank with API data (DESIGN §6.4): above the AI and unverified authors. */
async function applyFacts(db: Db, bookId: string, currentTitle: string, p: ResearchProposal, runId: string) {
  const facts = p.facts ?? {};
  const confidence = CONFIDENCE_VALUES[p.confidence];
  const writes: FieldWrite[] = [];
  // A title is only corrected when it's the same title written differently ("The Land: Founding"
  // for "Founding"); a genuinely different title is a conflict for the owner.
  if (facts.title && titleKey(facts.title) === titleKey(currentTitle) && facts.title !== currentTitle) {
    writes.push({ field: "title", value: facts.title, confidence });
  }
  if (facts.series_position !== undefined)
    writes.push({ field: "seriesPosition", value: facts.series_position, confidence });
  if (facts.first_published)
    writes.push({ field: "firstPublished", value: facts.first_published, confidence });
  if (writes.length === 0) return [];
  return writeBookFields(db, bookId, writes, { source: "research", sourceRef: `run:${runId}` });
}

async function settle(db: Db, id: string, status: "accepted" | "unverified", result: unknown) {
  await db.update(editorialProposals).set({ status, result }).where(eq(editorialProposals.id, id));
}

/** For tests and the console: proposals by status. */
export async function proposalsByStatus(
  db: Db,
  statuses: (typeof editorialProposals.$inferSelect)["status"][],
) {
  return db.select().from(editorialProposals).where(inArray(editorialProposals.status, statuses));
}
