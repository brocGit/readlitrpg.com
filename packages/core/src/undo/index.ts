// Undo from the audit log (DESIGN §8.3). An action that can be reversed stores how in its audit
// row's diff as `undo`: a small spec naming the change that puts things back. The audit log can't
// be edited, so an undo is a new row (`audit.undo`) pointing at the one it reverses; a row with one
// pointing at it counts as undone. Undo works for 30 days. Sent email and refunds can't be undone.

import { and, desc, eq, gte, inArray, like } from "drizzle-orm";
import { z } from "zod";
import { setCampaignState } from "../ads/campaigns";
import { type AuditActor, type AuditRow, appendAudit } from "../audit";
import { removeMemberAsAdmin } from "../authors/admin";
import { setVisibility } from "../catalog/confirm";
import { resolveBookFields } from "../catalog/fields";
import { unmergeBooks } from "../catalog/merge";
import { releaseSlots } from "../content/calendar";
import { publishPost, setPostStatus } from "../content/posts";
import type { Db } from "../db";
import { auditLog, authors, bookFieldSources, POST_STATUSES, TRUST_LEVELS } from "../db/schema";
import { setQuizStatus } from "../quiz/takes";
import { resetSetting, SETTINGS, type SettingKey, type SettingsDeps, updateSetting } from "../settings";
import { nowIso } from "../time";

export const UNDO_DAYS = 30;

const id = z.string().min(1).max(60);

export const undoSpecSchema = z.discriminatedUnion("kind", [
  /** A post back to a status: unpublish, or reinstate a rejected post for review. */
  z.object({ kind: z.literal("post_status"), postId: id, to: z.enum(POST_STATUSES) }),
  z.object({ kind: z.literal("campaign_state"), id, to: z.enum(["paused", "scheduled"]) }),
  z.object({ kind: z.literal("visibility"), bookId: id, to: z.enum(["published", "hidden", "draft"]) }),
  /** Drop one provenance row (the owner's override) and let precedence pick the value again. */
  z.object({ kind: z.literal("field_source"), bookId: id, sourceId: id }),
  z.object({ kind: z.literal("merge"), mergeId: id }),
  /** Put a setting back: an earlier override, or the default when `reset`. */
  z.object({
    kind: z.literal("setting"),
    key: z.string().max(80),
    value: z.unknown().optional(),
    reset: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("author_trust"), authorId: id, to: z.enum(TRUST_LEVELS) }),
  z.object({ kind: z.literal("quiz_status"), slug: z.string().max(80), to: z.enum(["live", "retired"]) }),
  /** Take back a membership an approval granted. */
  z.object({ kind: z.literal("member_remove"), authorId: id, userId: id }),
]);
export type UndoSpec = z.infer<typeof undoSpecSchema>;

/** What the Undo button says it will do. */
export function describeUndo(spec: UndoSpec): string {
  switch (spec.kind) {
    case "post_status":
      return spec.to === "unpublished"
        ? "Unpublish the post"
        : spec.to === "published"
          ? "Publish the post again"
          : spec.to === "in_review"
            ? "Put the post back in review"
            : `Set the post back to ${spec.to.replace("_", " ")}`;
    case "campaign_state":
      return spec.to === "paused" ? "Pause the campaign again" : "Resume the campaign";
    case "visibility":
      return spec.to === "published" ? "Publish the book again" : `Set the book back to ${spec.to}`;
    case "field_source":
      return "Remove your override (the next source's value returns)";
    case "merge":
      return "Split the merged books apart";
    case "setting":
      return spec.reset ? `Reset ${spec.key} to its default` : `Set ${spec.key} back`;
    case "author_trust":
      return `Set the author's trust back to ${spec.to}`;
    case "quiz_status":
      return spec.to === "retired" ? "Take the quiz down" : "Put the quiz back up";
    case "member_remove":
      return "Remove the member the approval added";
  }
}

/** The undo spec a row carries, if it has a valid one. */
export function undoOf(row: Pick<AuditRow, "diff">): UndoSpec | null {
  const raw = (row.diff as { undo?: unknown } | null)?.undo;
  if (!raw) return null;
  const parsed = undoSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export class UndoError extends Error {}

export interface UndoDeps {
  /** Settings changes go through the settings module (validation, cache drop). */
  settings?: Omit<SettingsDeps, "db">;
}

/** Apply a spec. Throws UndoError when the thing it would restore is gone or refuses. */
export async function applyUndoSpec(
  db: Db,
  spec: UndoSpec,
  actor: AuditActor,
  deps: UndoDeps = {},
  now = new Date(),
): Promise<void> {
  const actorId = actor.id ?? actor.type;
  switch (spec.kind) {
    case "post_status": {
      if (spec.to === "published") {
        await publishPost(db, spec.postId, now);
        return;
      }
      // Back to scheduled keeps its time; anywhere else leaves the calendar and gives the slot back.
      const scheduled = spec.to === "scheduled";
      if (!scheduled) await releaseSlots(db, spec.postId);
      if (!(await setPostStatus(db, spec.postId, spec.to, { now, publishAt: scheduled ? undefined : null })))
        throw new UndoError("that post no longer exists");
      return;
    }
    case "campaign_state":
      await setCampaignState(db, spec.id, spec.to, now);
      return;
    case "visibility": {
      const r = await setVisibility(db, spec.bookId, spec.to);
      if (!r.ok) throw new UndoError(`the book can't be ${spec.to}: ${r.reason}`);
      return;
    }
    case "field_source": {
      const gone = await db
        .delete(bookFieldSources)
        .where(and(eq(bookFieldSources.id, spec.sourceId), eq(bookFieldSources.bookId, spec.bookId)))
        .returning({ id: bookFieldSources.id });
      if (!gone.length) throw new UndoError("that value was already removed");
      await resolveBookFields(db, spec.bookId);
      return;
    }
    case "merge":
      try {
        await unmergeBooks(db, spec.mergeId, actorId);
      } catch (error) {
        throw new UndoError(error instanceof Error ? error.message : "the merge can't be undone");
      }
      return;
    case "setting": {
      if (!deps.settings) throw new UndoError("settings can only be undone from the console");
      if (!(spec.key in SETTINGS)) throw new UndoError(`${spec.key} is no longer a setting`);
      const key = spec.key as SettingKey;
      const sdeps = { db, ...deps.settings, actor };
      if (spec.reset) await resetSetting(sdeps, key);
      else await updateSetting(sdeps, key, spec.value);
      return;
    }
    case "author_trust": {
      const rows = await db
        .update(authors)
        .set({ trustLevel: spec.to, updatedAt: nowIso(now) })
        .where(eq(authors.id, spec.authorId))
        .returning({ id: authors.id });
      if (!rows.length) throw new UndoError("that author no longer exists");
      return;
    }
    case "quiz_status":
      await setQuizStatus(db, spec.slug, spec.to, actorId);
      return;
    case "member_remove":
      await removeMemberAsAdmin(db, spec.authorId, spec.userId, actorId);
      return;
  }
}

/** Rows that undo others, for marking what's already undone. */
async function undoneIds(db: Db, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select({ subjectId: auditLog.subjectId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "audit.undo"),
          eq(auditLog.subjectType, "audit"),
          inArray(auditLog.subjectId, ids.slice(i, i + 90)),
        ),
      );
    for (const r of rows) if (r.subjectId) out.add(r.subjectId);
  }
  return out;
}

export interface AuditView extends AuditRow {
  undo: UndoSpec | null;
  /** "open" can be undone now; "done" was undone; "expired" is past the 30 days. */
  undoState: "open" | "done" | "expired" | null;
}

/** Decorate audit rows with what can be undone. */
export async function withUndo(db: Db, rows: AuditRow[], now = new Date()): Promise<AuditView[]> {
  const cutoff = new Date(now.getTime() - UNDO_DAYS * 86_400_000).toISOString();
  const withSpecs = rows.map((r) => ({ ...r, undo: undoOf(r) }));
  const done = await undoneIds(
    db,
    withSpecs.filter((r) => r.undo).map((r) => r.id),
  );
  return withSpecs.map((r) => ({
    ...r,
    undoState: !r.undo ? null : done.has(r.id) ? "done" : r.createdAt < cutoff ? "expired" : "open",
  }));
}

export interface AuditFilter {
  /** An action, or a prefix ending in "." (e.g. "inbox."). */
  action?: string;
  actorType?: string;
  /** Only rows that can still be undone. */
  undoable?: boolean;
  limit?: number;
}

export async function listAudit(db: Db, f: AuditFilter = {}, now = new Date()): Promise<AuditView[]> {
  const action = f.action?.trim();
  const conds = [
    action
      ? action.endsWith(".")
        ? like(auditLog.action, `${action}%`)
        : eq(auditLog.action, action)
      : undefined,
    f.actorType ? eq(auditLog.actorType, f.actorType as AuditRow["actorType"]) : undefined,
    f.undoable
      ? and(
          gte(auditLog.createdAt, new Date(now.getTime() - UNDO_DAYS * 86_400_000).toISOString()),
          like(auditLog.diff, '%"undo":%'),
        )
      : undefined,
  ];
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.seq))
    .limit(f.limit ?? 100);
  const views = await withUndo(db, rows, now);
  return f.undoable ? views.filter((v) => v.undoState === "open") : views;
}

/** Undo one audited action: check it's open, apply it, and record the undo. */
export async function undoAudit(
  db: Db,
  auditId: string,
  actor: AuditActor,
  deps: UndoDeps & { requestId?: string } = {},
  now = new Date(),
): Promise<{ row: AuditRow; spec: UndoSpec }> {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.id, auditId));
  if (!row) throw new UndoError("no such audit entry");
  const [view] = await withUndo(db, [row], now);
  if (!view?.undo) throw new UndoError("that action can't be undone");
  if (view.undoState === "done") throw new UndoError("that was already undone");
  if (view.undoState === "expired") throw new UndoError(`undo only works for ${UNDO_DAYS} days`);
  await applyUndoSpec(db, view.undo, actor, deps, now);
  await appendAudit(db, {
    actor,
    action: "audit.undo",
    subjectType: "audit",
    subjectId: row.id,
    diff: { seq: row.seq, action: row.action, spec: view.undo },
    requestId: deps.requestId,
  });
  return { row, spec: view.undo };
}
