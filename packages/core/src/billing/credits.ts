// Promo credits (DESIGN §12.5): an append-only ledger per advertiser. The balance is the sum of
// its rows; spending is a single conditional INSERT, so two checkouts at once can't overdraw it.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { type CreditReason, creditsLedger } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export async function creditBalance(db: Db, advertiserId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${creditsLedger.deltaCents}), 0)` })
    .from(creditsLedger)
    .where(eq(creditsLedger.advertiserId, advertiserId));
  return Number(row?.n ?? 0);
}

export interface CreditEntry {
  advertiserId: string;
  amountCents: number;
  reason: CreditReason;
  ref?: string | null;
  note?: string | null;
  createdBy: string;
}

/** Add credits. Amounts must be positive; spending goes through `spendCredits`. */
export async function addCredit(db: Db, e: CreditEntry, now = new Date()): Promise<string> {
  if (!Number.isInteger(e.amountCents) || e.amountCents <= 0)
    throw new Error("credit must be positive cents");
  const id = ulid();
  await db.insert(creditsLedger).values({
    id,
    advertiserId: e.advertiserId,
    deltaCents: e.amountCents,
    reason: e.reason,
    ref: e.ref ?? null,
    note: e.note?.slice(0, 500) ?? null,
    createdBy: e.createdBy,
    createdAt: nowIso(now),
  });
  return id;
}

/**
 * Spend credits if the balance covers them. One statement: the balance check and the debit can't
 * be split by another request. Returns false when the balance is short.
 */
export async function spendCredits(db: Db, e: CreditEntry, now = new Date()): Promise<boolean> {
  if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) return e.amountCents === 0;
  const rows = await db.all<{ id: string }>(sql`
    INSERT INTO credits_ledger (id, advertiser_id, delta_cents, reason, ref, note, created_by, created_at)
    SELECT ${ulid()}, ${e.advertiserId}, ${-e.amountCents}, ${e.reason}, ${e.ref ?? null},
           ${e.note ?? null}, ${e.createdBy}, ${nowIso(now)}
    WHERE (SELECT coalesce(sum(delta_cents), 0) FROM credits_ledger WHERE advertiser_id = ${e.advertiserId})
          >= ${e.amountCents}
    RETURNING id`);
  return rows.length === 1;
}

export async function creditHistory(db: Db, advertiserId: string, limit = 50) {
  return db
    .select()
    .from(creditsLedger)
    .where(and(eq(creditsLedger.advertiserId, advertiserId)))
    .orderBy(desc(creditsLedger.createdAt), desc(creditsLedger.id))
    .limit(limit);
}
