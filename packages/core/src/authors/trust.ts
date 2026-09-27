// Trust recompute (DESIGN §2.2): T1 authors who have earned it become T2 (Trusted), whose ad
// creatives approve when the automated checks pass. Promotion only; demotion is the owner's call
// or a chargeback's. Every change is audited with an undo.

import { and, count, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { appendAudit } from "../audit";
import type { Db } from "../db";
import { advertisers, authors, bookAuthors, books, campaigns, orders } from "../db/schema";
import { nowIso } from "../time";

const DAY_MS = 86_400_000;

/**
 * T1 for 60 days or more, at least 3 published books, at least one paid campaign delivered, and no
 * rejected campaign or payment dispute. Returns the authors promoted.
 */
export async function promoteTrusted(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - 60 * DAY_MS).toISOString();
  const candidates = await db
    .select({ id: authors.id })
    .from(authors)
    .where(and(eq(authors.trustLevel, "T1"), isNotNull(authors.verifiedAt), lte(authors.verifiedAt, cutoff)))
    .limit(200);
  const promoted: string[] = [];
  for (const { id } of candidates) {
    const [pub] = await db
      .select({ n: count() })
      .from(bookAuthors)
      .innerJoin(books, eq(books.id, bookAuthors.bookId))
      .where(and(eq(bookAuthors.authorId, id), eq(books.visibility, "published")));
    if ((pub?.n ?? 0) < 3) continue;
    const [adv] = await db
      .select({ id: advertisers.id })
      .from(advertisers)
      .where(and(eq(advertisers.ownerType, "author"), eq(advertisers.ownerId, id)));
    if (!adv) continue;
    const history = await db
      .select({ status: campaigns.status, settled: campaigns.settledAt })
      .from(campaigns)
      .where(eq(campaigns.advertiserId, adv.id));
    const delivered = history.some((c) => c.status === "completed" && c.settled);
    const rejected = history.some((c) => c.status === "rejected");
    if (!delivered || rejected) continue;
    const [disputed] = await db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.advertiserId, adv.id), inArray(orders.status, ["disputed"])));
    if ((disputed?.n ?? 0) > 0) continue;
    const moved = await db
      .update(authors)
      .set({ trustLevel: "T2", updatedAt: nowIso(now) })
      .where(and(eq(authors.id, id), eq(authors.trustLevel, "T1")))
      .returning({ id: authors.id });
    if (!moved.length) continue;
    await appendAudit(db, {
      actor: { type: "system", id: "trust.recompute" },
      action: "author.trust",
      subjectType: "author",
      subjectId: id,
      diff: {
        from: "T1",
        to: "T2",
        via: "recompute",
        undo: { kind: "author_trust", authorId: id, to: "T1" },
      },
    });
    promoted.push(id);
  }
  return promoted;
}
