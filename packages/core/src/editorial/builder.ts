// Filling the editorial queue (DESIGN §7.1 step 1, §7.13). Runs on a schedule in the jobs Worker.
// It only records *what* needs doing; the payload is built fresh when a run claims the item.

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db";
import { books, editorialQueue, inboxItems } from "../db/schema";
import type { Settings } from "../settings";
import { addHours } from "../time";
import { enqueue } from "./queue";

/** How long a finished research item blocks another try for the same book. */
export const RESEARCH_RETRY_DAYS = 30;

export interface BuildResult {
  classify: number;
  dedupe: number;
  research: number;
}

export async function buildEditorialQueue(
  db: Db,
  settings: Settings,
  now = new Date(),
): Promise<BuildResult> {
  const limit = settings["editorial.queue_batch"];
  const priorities = settings["editorial.priorities"];

  // Classify: every live book that no run has classified yet.
  const unclassified = await db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        isNull(books.classifiedAt),
        isNull(books.redirectTo),
        ne(books.visibility, "removed"),
        sql`not exists (select 1 from ${editorialQueue} q where q.open_key = 'classify:book:' || ${books.id})`,
      ),
    )
    .orderBy(books.createdAt)
    .limit(limit);
  const classify = await enqueue(
    db,
    unclassified.map((b) => ({
      kind: "classify",
      subjectType: "book",
      subjectId: b.id,
      priority: priorities.classify,
    })),
  );

  // Dedupe: open "Possible duplicate" items that no run has pre-judged.
  const undecided = await db
    .select({ id: inboxItems.id })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.type, "possible_duplicate"),
        eq(inboxItems.status, "open"),
        isNull(inboxItems.aiSummary),
        sql`not exists (select 1 from ${editorialQueue} q where q.open_key = 'dedupe:inbox_item:' || ${inboxItems.id})`,
      ),
    )
    .limit(limit);
  const dedupe = await enqueue(
    db,
    undecided.map((i) => ({
      kind: "dedupe",
      subjectType: "inbox_item",
      subjectId: i.id,
      priority: priorities.dedupe,
    })),
  );

  // Research: seeds Open Library and Google Books couldn't confirm, not tried in the last 30 days.
  const since = addHours(now.toISOString(), -RESEARCH_RETRY_DAYS * 24);
  const unconfirmed = await db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        isNull(books.confirmedAt),
        eq(books.enrichStatus, "no_match"),
        isNull(books.redirectTo),
        ne(books.visibility, "removed"),
        sql`not exists (select 1 from ${editorialQueue} q where q.kind = 'research' and q.subject_id = ${books.id}
          and (q.status in ('queued', 'claimed') or q.updated_at > ${since}))`,
      ),
    )
    .limit(limit);
  const research = await enqueue(
    db,
    unconfirmed.map((b) => ({
      kind: "research",
      subjectType: "book",
      subjectId: b.id,
      priority: priorities.research,
    })),
  );

  return { classify, dedupe, research };
}
