// Inventory (DESIGN §11.3): one unit per slot and period (and target, for per-tag and per-book
// slots), with a price snapshot. `available = capacity − sold − held`, and holding or selling a
// unit is one conditional UPDATE, so two buyers can never take the last place.

import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db";
import { type AdPeriod, adProducts, adSlots, bookings, campaigns, inventoryUnits } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => day(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000));

/** The period a date falls in: the day itself, or its Monday-to-Sunday week (issues are weekly). */
export function periodFor(period: AdPeriod, date: string): { start: string; end: string } {
  if (period === "day") return { start: date, end: date };
  const d = new Date(`${date}T00:00:00Z`);
  const start = addDays(date, -((d.getUTCDay() + 6) % 7));
  return { start, end: addDays(start, 6) };
}

/** Units for every untargeted slot, `daysAhead` from today (`inventory.generate`, nightly). */
export async function generateInventory(db: Db, now = new Date(), daysAhead = 120): Promise<number> {
  const slots = await db
    .select({
      id: adSlots.id,
      period: adSlots.period,
      capacity: adSlots.capacityPerPeriod,
      price: adProducts.basePriceCents,
    })
    .from(adSlots)
    .innerJoin(adProducts, eq(adProducts.id, adSlots.productId))
    .where(and(eq(adSlots.active, true), eq(adSlots.targeting, "none")));
  let created = 0;
  const today = day(now);
  for (const s of slots) {
    const rows: (typeof inventoryUnits.$inferInsert)[] = [];
    const seen = new Set<string>();
    for (let i = 0; i <= daysAhead; i++) {
      const p = periodFor(s.period, addDays(today, i));
      if (seen.has(p.start)) continue;
      seen.add(p.start);
      rows.push({
        id: ulid(),
        slotId: s.id,
        periodStart: p.start,
        periodEnd: p.end,
        capacity: s.capacity,
        priceCents: s.price,
      });
    }
    // Ten bound parameters a row (defaults are bound too): 9 rows keep a statement under D1's 100.
    for (let i = 0; i < rows.length; i += 9) {
      const added = await db
        .insert(inventoryUnits)
        .values(rows.slice(i, i + 9))
        .onConflictDoNothing()
        .returning({ id: inventoryUnits.id });
      created += added.length;
    }
  }
  return created;
}

/** The unit for a slot, period and target, made on demand (targeted slots, or past the horizon). */
export async function ensureUnit(
  db: Db,
  slotKey: string,
  date: string,
  target = "",
): Promise<typeof inventoryUnits.$inferSelect | null> {
  const [slot] = await db
    .select({
      id: adSlots.id,
      period: adSlots.period,
      capacity: adSlots.capacityPerPeriod,
      price: adProducts.basePriceCents,
    })
    .from(adSlots)
    .innerJoin(adProducts, eq(adProducts.id, adSlots.productId))
    .where(eq(adSlots.key, slotKey));
  if (!slot) return null;
  const p = periodFor(slot.period, date);
  await db
    .insert(inventoryUnits)
    .values({
      id: ulid(),
      slotId: slot.id,
      periodStart: p.start,
      periodEnd: p.end,
      target,
      capacity: slot.capacity,
      priceCents: slot.price,
    })
    .onConflictDoNothing();
  const [unit] = await db
    .select()
    .from(inventoryUnits)
    .where(
      and(
        eq(inventoryUnits.slotId, slot.id),
        eq(inventoryUnits.periodStart, p.start),
        eq(inventoryUnits.target, target),
      ),
    );
  return unit ?? null;
}

/** Take a place in a unit at once (a comp booking: house reserved mode). False when it's full. */
export async function sellUnit(
  db: Db,
  unitId: string,
  opts: { allowBlackout?: boolean } = {},
): Promise<boolean> {
  const rows = await db
    .update(inventoryUnits)
    .set({ sold: sql`${inventoryUnits.sold} + 1` })
    .where(
      and(
        eq(inventoryUnits.id, unitId),
        sql`${inventoryUnits.sold} + ${inventoryUnits.held} < ${inventoryUnits.capacity}`,
        opts.allowBlackout ? undefined : eq(inventoryUnits.blackout, false),
      ),
    )
    .returning({ id: inventoryUnits.id });
  return rows.length === 1;
}

/** Hold a place for a checkout (§11.3). The heartbeat releases holds that expire. */
export async function holdUnit(db: Db, unitId: string): Promise<boolean> {
  const rows = await db
    .update(inventoryUnits)
    .set({ held: sql`${inventoryUnits.held} + 1` })
    .where(
      and(
        eq(inventoryUnits.id, unitId),
        eq(inventoryUnits.blackout, false),
        sql`${inventoryUnits.sold} + ${inventoryUnits.held} < ${inventoryUnits.capacity}`,
      ),
    )
    .returning({ id: inventoryUnits.id });
  return rows.length === 1;
}

/** Give back a place: a released hold, or a cancelled booking. */
export async function giveBack(db: Db, unitId: string, from: "held" | "sold"): Promise<void> {
  const col = from === "held" ? inventoryUnits.held : inventoryUnits.sold;
  await db
    .update(inventoryUnits)
    .set(from === "held" ? { held: sql`max(${col} - 1, 0)` } : { sold: sql`max(${col} - 1, 0)` })
    .where(eq(inventoryUnits.id, unitId));
}

/** Release holds past their expiry (every heartbeat). Returns how many. */
export async function releaseExpiredHolds(db: Db, now = new Date()): Promise<number> {
  const expired = await db
    .update(bookings)
    .set({ status: "released", updatedAt: nowIso(now) })
    .where(and(eq(bookings.status, "held"), lt(bookings.holdExpiresAt, nowIso(now))))
    .returning({ unitId: bookings.inventoryUnitId });
  for (const b of expired) await giveBack(db, b.unitId, "held");
  return expired.length;
}

export async function setBlackout(db: Db, unitId: string, on: boolean): Promise<void> {
  await db.update(inventoryUnits).set({ blackout: on }).where(eq(inventoryUnits.id, unitId));
}

export interface CalendarUnit {
  id: string;
  slot: string;
  periodStart: string;
  periodEnd: string;
  target: string;
  capacity: number;
  sold: number;
  held: number;
  blackout: boolean;
  priceCents: number;
  campaigns: string[];
}

/** Sold, held and free per slot and period, for the console's inventory calendar. */
export async function inventoryCalendar(db: Db, from: string, days = 35): Promise<CalendarUnit[]> {
  const to = addDays(from, days);
  const units = await db
    .select({
      id: inventoryUnits.id,
      slot: adSlots.key,
      periodStart: inventoryUnits.periodStart,
      periodEnd: inventoryUnits.periodEnd,
      target: inventoryUnits.target,
      capacity: inventoryUnits.capacity,
      sold: inventoryUnits.sold,
      held: inventoryUnits.held,
      blackout: inventoryUnits.blackout,
      priceCents: inventoryUnits.priceCents,
    })
    .from(inventoryUnits)
    .innerJoin(adSlots, eq(adSlots.id, inventoryUnits.slotId))
    .where(and(gte(inventoryUnits.periodEnd, from), lte(inventoryUnits.periodStart, to)))
    .orderBy(asc(inventoryUnits.periodStart), asc(adSlots.key))
    .limit(1_000);
  const booked: { unitId: string; name: string }[] = [];
  for (let i = 0; i < units.length; i += 90)
    booked.push(
      ...(await db
        .select({ unitId: bookings.inventoryUnitId, name: campaigns.name })
        .from(bookings)
        .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
        .where(
          and(
            inArray(bookings.status, ["held", "confirmed"]),
            inArray(
              bookings.inventoryUnitId,
              units.slice(i, i + 90).map((u) => u.id),
            ),
          ),
        )),
    );
  return units.map((u) => ({ ...u, campaigns: booked.filter((b) => b.unitId === u.id).map((b) => b.name) }));
}
