// The editorial calendar (DESIGN §14.2): each weekday has slot kinds (`blog.calendar`), and an
// approved post takes the next open slot of its kind. Roundups, "Today in LitRPG", news and the
// owner's own posts aren't slotted: they publish when they're built or when the owner says.

import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db";
import { editorialSlots, type PostType, posts, type SlotKind } from "../db/schema";
import { ulid } from "../ids";
import type { Settings } from "../settings";
import { nowIso } from "../time";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** The calendar slot a post type waits for, or null when it publishes on its own schedule. */
export function slotKindFor(type: PostType): SlotKind | null {
  if (type === "guest" || type === "interview") return "guest";
  if (type === "ai_editorial") return "editorial";
  return null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export class SlotError extends Error {}

/**
 * Claim the next open slot of `kind` for a post, from `from` onward (today's slot only if its hour
 * hasn't passed). Returns the publish time. The unique (date, kind) index makes claims race-safe.
 */
export async function claimNextSlot(
  db: Db,
  postId: string,
  kind: SlotKind,
  settings: Pick<Settings, "blog.calendar" | "blog.publish_hour_utc">,
  from = new Date(),
): Promise<string> {
  const calendar = settings["blog.calendar"];
  const hour = settings["blog.publish_hour_utc"];
  if (!Object.values(calendar).some((kinds) => kinds?.includes(kind)))
    throw new SlotError(`no weekday takes ${kind} posts (blog.calendar)`);
  await releaseSlots(db, postId);
  for (let offset = 0; offset < 120; offset++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset, hour));
    if (d.getTime() <= from.getTime()) continue;
    const weekday = WEEKDAYS[d.getUTCDay()] as (typeof WEEKDAYS)[number];
    if (!calendar[weekday]?.includes(kind)) continue;
    const claimed = await db
      .insert(editorialSlots)
      .values({ id: ulid(), date: day(d), kind, postId })
      .onConflictDoNothing()
      .returning({ id: editorialSlots.id });
    if (claimed.length) return d.toISOString();
  }
  throw new SlotError(`no open ${kind} slot in the next 120 days`);
}

/** Put a post in a given day's slot (the owner moving it). Fails if another post has that slot. */
export async function moveToSlot(
  db: Db,
  postId: string,
  kind: SlotKind,
  date: string,
  settings: Pick<Settings, "blog.publish_hour_utc">,
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SlotError("pick a date");
  const [taken] = await db
    .select({ postId: editorialSlots.postId })
    .from(editorialSlots)
    .where(and(eq(editorialSlots.date, date), eq(editorialSlots.kind, kind)));
  if (taken && taken.postId !== postId) throw new SlotError(`another post has the ${kind} slot on ${date}`);
  await releaseSlots(db, postId);
  await db.insert(editorialSlots).values({ id: ulid(), date, kind, postId }).onConflictDoNothing();
  const hour = String(settings["blog.publish_hour_utc"]).padStart(2, "0");
  const at = `${date}T${hour}:00:00.000Z`;
  await db.update(posts).set({ publishAt: at, updatedAt: nowIso() }).where(eq(posts.id, postId));
  return at;
}

/** Free a post's slot (unpublished, rejected, or moved). */
export async function releaseSlots(db: Db, postId: string): Promise<void> {
  await db.delete(editorialSlots).where(eq(editorialSlots.postId, postId));
}

export interface CalendarEntry {
  date: string;
  kind: SlotKind;
  postId: string | null;
  title: string | null;
  status: string | null;
}

/** Filled slots from `from` for `days`, for the console's calendar. */
export async function calendarEntries(db: Db, from: string, days = 28): Promise<CalendarEntry[]> {
  const to = day(new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000));
  return db
    .select({
      date: editorialSlots.date,
      kind: editorialSlots.kind,
      postId: editorialSlots.postId,
      title: posts.title,
      status: posts.status,
    })
    .from(editorialSlots)
    .leftJoin(posts, eq(posts.id, editorialSlots.postId))
    .where(and(gte(editorialSlots.date, from), lte(editorialSlots.date, to)))
    .orderBy(asc(editorialSlots.date), asc(editorialSlots.kind));
}
