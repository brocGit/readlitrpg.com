// Promotion codes (DESIGN §11.9): the owner's giveaways and launch-partner discounts. A code is a
// percent or an amount off, for some products or any, with a limited number of uses. A 100% code
// makes a comp order: no Stripe step at all.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { promoCodes } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export type PromoCode = typeof promoCodes.$inferSelect;

export class PromoError extends Error {}

export function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

export async function createPromoCode(
  db: Db,
  p: {
    code: string;
    percentOff?: number | null;
    amountOffCents?: number | null;
    products?: string[];
    maxRedemptions?: number;
    expiresAt?: string | null;
    note?: string | null;
    createdBy: string;
  },
): Promise<PromoCode> {
  const code = normalizeCode(p.code);
  if (code.length < 4 || code.length > 32) throw new PromoError("a code is 4–32 letters, digits or dashes");
  const percent = p.percentOff ?? null;
  const amount = p.amountOffCents ?? null;
  if ((percent === null) === (amount === null)) throw new PromoError("give a percent or an amount off");
  if (percent !== null && (!Number.isInteger(percent) || percent < 1 || percent > 100))
    throw new PromoError("the percent is 1–100");
  if (amount !== null && (!Number.isInteger(amount) || amount < 1))
    throw new PromoError("the amount is in cents");
  const max = Math.max(1, Math.min(10_000, Math.round(p.maxRedemptions ?? 1)));
  const rows = await db
    .insert(promoCodes)
    .values({
      id: ulid(),
      code,
      percentOff: percent,
      amountOffCents: amount,
      products: p.products ?? [],
      maxRedemptions: max,
      expiresAt: p.expiresAt ?? null,
      note: p.note?.slice(0, 300) ?? null,
      createdBy: p.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (!rows[0]) throw new PromoError("that code already exists");
  return rows[0];
}

/** A usable code for this product, or why not. */
export async function findPromo(
  db: Db,
  raw: string,
  productKey: string,
  now = new Date(),
): Promise<{ ok: true; promo: PromoCode } | { ok: false; reason: string }> {
  const code = normalizeCode(raw);
  const [promo] = code ? await db.select().from(promoCodes).where(eq(promoCodes.code, code)) : [];
  if (!promo?.active) return { ok: false, reason: "That code isn't valid." };
  if (promo.expiresAt && promo.expiresAt < nowIso(now))
    return { ok: false, reason: "That code has expired." };
  if (promo.redemptions >= promo.maxRedemptions) return { ok: false, reason: "That code has been used up." };
  if (promo.products.length && !promo.products.includes(productKey))
    return { ok: false, reason: "That code isn't for this product." };
  return { ok: true, promo };
}

export function discountFor(promo: PromoCode, amountCents: number): number {
  if (promo.percentOff !== null) return Math.floor((amountCents * promo.percentOff) / 100);
  return Math.min(amountCents, promo.amountOffCents ?? 0);
}

/** Take one use. False when it ran out meanwhile. */
export async function redeemPromo(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(promoCodes)
    .set({ redemptions: sql`${promoCodes.redemptions} + 1` })
    .where(
      and(
        eq(promoCodes.id, id),
        eq(promoCodes.active, true),
        sql`${promoCodes.redemptions} < ${promoCodes.maxRedemptions}`,
      ),
    )
    .returning({ id: promoCodes.id });
  return rows.length === 1;
}

/** Give a use back (the checkout it was for expired or was cancelled). */
export async function releasePromo(db: Db, id: string): Promise<void> {
  await db
    .update(promoCodes)
    .set({ redemptions: sql`max(${promoCodes.redemptions} - 1, 0)` })
    .where(eq(promoCodes.id, id));
}

export async function setPromoActive(db: Db, id: string, active: boolean): Promise<void> {
  await db.update(promoCodes).set({ active }).where(eq(promoCodes.id, id));
}

export async function listPromoCodes(db: Db, limit = 100): Promise<PromoCode[]> {
  return db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt)).limit(limit);
}
