// Release dates (DESIGN §9.4): one live row per book, kind and region. A new date moves the row and
// remembers the old one, so pages can say "Delayed from …" instead of silently changing.

import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Db } from "../db";
import { RELEASE_KINDS, releases } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { recordBookChange } from "./changes";
import { parseDate } from "./normalize";

export class ReleaseError extends Error {}

export type ReleaseKind = (typeof RELEASE_KINDS)[number];
export type ReleaseSource = "author" | "api" | "admin" | "ai" | "publisher";

export interface ReleaseChange {
  id: string;
  change: "added" | "moved" | "confirmed";
  previousDate: string | null;
}

export async function setRelease(
  db: Db,
  bookId: string,
  input: { kind: ReleaseKind; date: string; region?: string },
  by: ReleaseSource,
  now = new Date(),
): Promise<ReleaseChange> {
  if (!RELEASE_KINDS.includes(input.kind)) throw new ReleaseError(`unknown release kind "${input.kind}"`);
  const d = parseDate(input.date);
  if (!d) throw new ReleaseError(`can't read the date "${input.date}" (try 2026-11-03, Nov 2026 or Q1 2027)`);
  const region = (input.region ?? "US").toUpperCase().slice(0, 2);
  const today = now.toISOString().slice(0, 10);
  const stamp = nowIso(now);
  const released = d.precision === "day" && d.date !== null && d.date <= today;
  const [current] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.bookId, bookId),
        eq(releases.kind, input.kind),
        eq(releases.region, region),
        ne(releases.status, "cancelled"),
      ),
    )
    .orderBy(desc(releases.updatedAt))
    .limit(1);
  if (!current) {
    const id = ulid();
    await db.insert(releases).values({
      id,
      bookId,
      kind: input.kind,
      date: d.date,
      datePrecision: d.precision,
      region,
      status: released ? "released" : by === "author" || by === "publisher" ? "confirmed" : "scheduled",
      confirmedBy: by,
      confirmedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await notifyAuthors(db, bookId, by, input.kind, d.date, null);
    return { id, change: "added", previousDate: null };
  }
  if (current.date === d.date && current.datePrecision === d.precision) {
    await db
      .update(releases)
      .set({
        confirmedBy: by,
        confirmedAt: stamp,
        updatedAt: stamp,
        ...(released ? { status: "released" } : {}),
      })
      .where(eq(releases.id, current.id));
    return { id: current.id, change: "confirmed", previousDate: current.previousDate };
  }
  // Only a later date is a slip; an earlier or more precise one is just news.
  const slipped =
    current.date !== null && d.date !== null && d.date > current.date && current.status !== "released";
  await db
    .update(releases)
    .set({
      date: d.date,
      datePrecision: d.precision,
      status: released
        ? "released"
        : slipped
          ? "slipped"
          : by === "author" || by === "publisher"
            ? "confirmed"
            : "scheduled",
      previousDate: slipped ? current.date : current.previousDate,
      confirmedBy: by,
      confirmedAt: stamp,
      updatedAt: stamp,
    })
    .where(eq(releases.id, current.id));
  await notifyAuthors(db, bookId, by, input.kind, d.date, current.date);
  return { id: current.id, change: "moved", previousDate: slipped ? current.date : current.previousDate };
}

/** Dates set by the owner, an API or a run are news to the book's authors (§10.4). */
async function notifyAuthors(
  db: Db,
  bookId: string,
  by: ReleaseSource,
  kind: string,
  date: string | null,
  from: string | null,
) {
  if (by === "author" || by === "publisher") return;
  await recordBookChange(db, bookId, by, ["release"], { kind, from, to: date });
}

export async function cancelRelease(db: Db, bookId: string, releaseId: string): Promise<boolean> {
  const rows = await db
    .update(releases)
    .set({ status: "cancelled", updatedAt: nowIso() })
    .where(and(eq(releases.id, releaseId), eq(releases.bookId, bookId)))
    .returning({ id: releases.id });
  return rows.length === 1;
}

/**
 * Release rollover (DESIGN §7.7): a dated release whose day has come is out. US releases roll over
 * by New York's date, so a book out "today" in the US isn't marked released early in the evening.
 */
export async function rolloverReleases(db: Db, now = new Date()): Promise<number> {
  const newYork = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const rows = await db
    .update(releases)
    .set({ status: "released", updatedAt: nowIso(now) })
    .where(
      and(
        inArray(releases.status, ["scheduled", "confirmed", "slipped"]),
        eq(releases.datePrecision, "day"),
        lte(releases.date, newYork),
      ),
    )
    .returning({ id: releases.id });
  return rows.length;
}
