// Authors editing their own books (DESIGN §10.4). `planEdit` is the rule table as a pure function:
// what applies at once, and what goes to the Owner Inbox as a protected change (and when its default
// runs). `applyEdit` makes the changes, always as the author, so provenance and precedence decide
// what readers see and nothing here notifies the author about their own edit.

import { and, eq, gte, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { setVisibility } from "../catalog/confirm";
import { type FieldWrite, writeBookFields } from "../catalog/fields";
import { cleanText, parseDate, parseLink } from "../catalog/normalize";
import { cancelRelease, setRelease } from "../catalog/releases";
import { findOrCreateNarrator, findOrCreateSeries } from "../catalog/resolve";
import { writeAuthorDials } from "../catalog/scores";
import { writeBookTags } from "../catalog/tags";
import type { Db } from "../db";
import {
  AI_USE,
  bookAuthors,
  bookLinks,
  bookScores,
  books,
  bookTags,
  editionNarrators,
  editions,
  HAREM,
  narrators as narrators_,
  RELEASE_KINDS,
  releases,
  series as seriesTable,
  tags,
} from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import type { TrustLevel } from "../policy";
import type { Settings } from "../settings";
import { CONTENT_FLAGS, DIAL_KEYS } from "../taxonomy";
import { nowIso } from "../time";

const text = (max: number) => z.string().trim().max(max);

export const editPatchSchema = z
  .object({
    title: text(300).min(1),
    subtitle: text(300).nullable(),
    series: z.object({ name: text(200).min(1), position: z.number().min(0).max(1000).optional() }).nullable(),
    blurb: text(5_000).nullable(),
    addLinks: z.array(text(2_000).min(1)).max(10),
    kindleUnlimited: z.boolean(),
    narrators: z.array(text(200).min(1)).max(10),
    tags: z.array(text(80).min(1)).max(20),
    dials: z.record(z.string(), z.number().min(0).max(10)),
    crunchLevel: z.number().int().min(0).max(3).nullable(),
    romanceLevel: z.number().int().min(0).max(4).nullable(),
    harem: z.enum(HAREM),
    contentFlags: z
      .array(z.string().refine((f) => CONTENT_FLAGS.includes(f), "unknown content note"))
      .max(10),
    aiUse: z.enum(AI_USE).refine((v) => v !== "unknown", "tell readers how AI was used"),
    release: z.object({ kind: z.enum(RELEASE_KINDS), date: text(40).min(1) }),
    cancelRelease: text(40),
    hidden: z.boolean(),
    embargoUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .partial();
export type EditPatch = z.infer<typeof editPatchSchema>;

export interface EditState {
  trust: TrustLevel;
  /** Out already: a release in the past, or a first-published date. */
  released: boolean;
  releases: { id: string; kind: string; date: string | null; precision: string; status: string }[];
}

export interface ProtectedPart {
  patch: EditPatch;
  reason: string;
  /** Hours until the default approval; null waits for the owner. */
  afterHours: number | null;
}

export interface EditPlan {
  immediate: EditPatch;
  protected: ProtectedPart[];
}

const HOUR = 3_600_000;
const within72h = (date: string | null, now: Date) =>
  date !== null && Date.parse(`${date}T00:00:00Z`) - now.getTime() < 72 * HOUR;

/** The §10.4 table. T0 edits all wait for review; a restricted (T-1) profile waits for the owner. */
export function planEdit(state: EditState, patch: EditPatch, now: Date, t0Hours: number): EditPlan {
  const immediate: EditPatch = {};
  const parts: ProtectedPart[] = [];
  const add = (key: keyof EditPatch, reason: string, afterHours: number | null) =>
    parts.push({ patch: { [key]: patch[key] } as EditPatch, reason, afterHours });

  for (const key of Object.keys(patch) as (keyof EditPatch)[]) {
    if (patch[key] === undefined) continue;
    // Hiding a listing is immediate at every level: it's the author's book (§10.4).
    if (key === "hidden") {
      immediate.hidden = patch.hidden;
      continue;
    }
    let rule: { reason: string; afterHours: number | null } | null = null;
    if (key === "series") rule = { reason: "series reassignment", afterHours: null };
    else if ((key === "title" || key === "subtitle") && state.released)
      rule = { reason: "title change after release", afterHours: null };
    else if (key === "release" && patch.release) {
      const current = state.releases.find((r) => r.kind === patch.release?.kind && r.status !== "cancelled");
      const next = parseDate(patch.release.date);
      const currentSoon = current?.precision === "day" && within72h(current.date, now);
      const nextSoon = next?.precision === "day" && within72h(next.date, now);
      if (currentSoon || nextSoon)
        rule = { reason: "release date within 72 hours of release, or after it", afterHours: 24 };
    }
    if (state.trust === "T-1") rule = { reason: rule?.reason ?? "restricted profile", afterHours: null };
    else if (state.trust === "T0") rule = rule ?? { reason: "unverified author", afterHours: t0Hours };
    if (rule) add(key, rule.reason, rule.afterHours);
    else (immediate as Record<string, unknown>)[key] = patch[key];
  }
  // One inbox item per reason and default.
  const merged: ProtectedPart[] = [];
  for (const p of parts) {
    const same = merged.find((m) => m.reason === p.reason && m.afterHours === p.afterHours);
    if (same) same.patch = { ...same.patch, ...p.patch };
    else merged.push(p);
  }
  return { immediate, protected: merged };
}

export async function editState(
  db: Db,
  bookId: string,
  trust: TrustLevel,
  now = new Date(),
): Promise<EditState> {
  const [book] = await db
    .select({ firstPublished: books.firstPublished })
    .from(books)
    .where(eq(books.id, bookId));
  const rels = await db
    .select({
      id: releases.id,
      kind: releases.kind,
      date: releases.date,
      precision: releases.datePrecision,
      status: releases.status,
    })
    .from(releases)
    .where(eq(releases.bookId, bookId));
  const today = now.toISOString().slice(0, 10);
  const released =
    rels.some(
      (r) => r.status === "released" || (r.precision === "day" && r.date !== null && r.date <= today),
    ) ||
    (book?.firstPublished != null && book.firstPublished <= today);
  return { trust, released, releases: rels };
}

export interface EditContext {
  userId: string;
  authorId: string;
  trust: TrustLevel;
  settings: Settings;
  now?: Date;
}

export class EditError extends Error {}

/** Plan an edit, apply what may apply now, and queue the rest. Returns what happened. */
export async function editBook(db: Db, bookId: string, raw: unknown, ctx: EditContext) {
  const parsed = editPatchSchema.safeParse(raw);
  if (!parsed.success) throw new EditError(parsed.error.issues[0]?.message ?? "check the form");
  const now = ctx.now ?? new Date();
  const plan = planEdit(
    await editState(db, bookId, ctx.trust, now),
    parsed.data,
    now,
    ctx.settings["publish.t0_default_action_hours"],
  );
  const applied = Object.keys(plan.immediate).length ? await applyEdit(db, bookId, plan.immediate, ctx) : [];
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, bookId));
  const queued: string[] = [];
  for (const part of plan.protected) {
    const item = await openInboxItem(db, {
      type: "protected_change",
      title: `Author change to "${book?.title ?? "a book"}": ${part.reason}`,
      subjectType: "book",
      subjectId: bookId,
      priority: part.afterHours === null ? 60 : 40,
      payload: { bookId, authorId: ctx.authorId, userId: ctx.userId, patch: part.patch, reason: part.reason },
      defaultAction: part.afterHours === null ? "none" : "approve",
      defaultActionAt:
        part.afterHours === null ? undefined : new Date(now.getTime() + part.afterHours * HOUR).toISOString(),
      dedupeKey: `protected:${bookId}:${ulid()}`,
    });
    if (item) queued.push(part.reason);
  }
  return { applied, queued };
}

/** Apply a (planned or approved) patch as the author. Returns the parts that were applied. */
export async function applyEdit(
  db: Db,
  bookId: string,
  patch: EditPatch,
  ctx: { userId: string; authorId: string; trust: TrustLevel; settings: Settings; now?: Date },
): Promise<string[]> {
  const source = ctx.trust === "T1" || ctx.trust === "T2" ? "author_verified" : "author";
  const done: string[] = [];
  const fields: FieldWrite[] = [];
  if (patch.title !== undefined) fields.push({ field: "title", value: cleanText(patch.title) });
  if (patch.subtitle !== undefined)
    fields.push({ field: "subtitle", value: patch.subtitle ? cleanText(patch.subtitle) : null });
  if (patch.blurb !== undefined)
    fields.push({ field: "blurbAuthor", value: patch.blurb ? cleanText(patch.blurb) : null });
  if (patch.crunchLevel !== undefined) fields.push({ field: "crunchLevel", value: patch.crunchLevel });
  if (patch.romanceLevel !== undefined) fields.push({ field: "romanceLevel", value: patch.romanceLevel });
  if (patch.harem !== undefined) fields.push({ field: "harem", value: patch.harem });
  if (patch.contentFlags !== undefined) fields.push({ field: "contentFlags", value: patch.contentFlags });
  if (patch.aiUse !== undefined) fields.push({ field: "isAiGenerated", value: patch.aiUse });
  if (patch.series !== undefined) {
    if (patch.series) {
      const ids = (
        await db.select({ id: bookAuthors.authorId }).from(bookAuthors).where(eq(bookAuthors.bookId, bookId))
      ).map((r) => r.id);
      const s = await findOrCreateSeries(db, patch.series.name, ids, "author");
      fields.push(
        { field: "seriesId", value: s.id },
        { field: "seriesPosition", value: patch.series.position ?? null },
      );
    } else fields.push({ field: "seriesId", value: null }, { field: "seriesPosition", value: null });
  }
  if (fields.length) {
    await writeBookFields(db, bookId, fields, {
      source,
      sourceRef: `author:${ctx.authorId}`,
      createdBy: ctx.userId,
    });
    done.push(...fields.map((f) => f.field));
  }
  if (patch.addLinks?.length) {
    for (const raw of patch.addLinks) {
      const r = parseLink(raw);
      if (!r.ok) continue;
      await db
        .insert(bookLinks)
        .values({
          id: ulid(),
          bookId,
          kind: r.link.kind === "other" ? "author_site" : r.link.kind,
          url: r.link.url,
          region: r.link.region,
        })
        .onConflictDoNothing();
    }
    done.push("links");
  }
  if (patch.kindleUnlimited !== undefined) {
    const [ebook] = await db
      .select({ id: editions.id })
      .from(editions)
      .where(and(eq(editions.bookId, bookId), eq(editions.format, "ebook")));
    if (ebook)
      await db
        .update(editions)
        .set({ kindleUnlimited: patch.kindleUnlimited, updatedAt: nowIso() })
        .where(eq(editions.id, ebook.id));
    else
      await db
        .insert(editions)
        .values({ id: ulid(), bookId, format: "ebook", kindleUnlimited: patch.kindleUnlimited });
    done.push("kindleUnlimited");
  }
  if (patch.narrators !== undefined) {
    let [audio] = await db
      .select({ id: editions.id })
      .from(editions)
      .where(and(eq(editions.bookId, bookId), eq(editions.format, "audiobook")));
    if (!audio && patch.narrators.length) {
      audio = { id: ulid() };
      await db.insert(editions).values({ id: audio.id, bookId, format: "audiobook" });
    }
    if (audio) {
      await db.delete(editionNarrators).where(eq(editionNarrators.editionId, audio.id));
      for (const [position, n] of patch.narrators.entries()) {
        const narratorId = await findOrCreateNarrator(db, n);
        await db
          .insert(editionNarrators)
          .values({ editionId: audio.id, narratorId, position })
          .onConflictDoNothing();
      }
    }
    done.push("narrators");
  }
  if (patch.tags !== undefined) {
    // The author's list is their whole answer: a tag they asserted before, or one the book shows now,
    // that isn't on the list becomes the author's "no" (blended with the AI's evidence, §6.2).
    const earlier = await db
      .select({ slug: tags.slug })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(
        and(eq(bookTags.bookId, bookId), or(eq(bookTags.authorAsserted, true), gte(bookTags.score, 0.5))),
      );
    const keep = new Set(patch.tags);
    const writes = [
      ...patch.tags.map((slug) => ({ slug, value: 1 })),
      ...earlier.filter((e) => !keep.has(e.slug)).map((e) => ({ slug: e.slug, value: 0 })),
    ];
    await writeBookTags(db, bookId, writes, source, ctx.settings["tags.crowd_min_votes"]);
    done.push("tags");
  }
  if (patch.dials !== undefined) {
    const dials = Object.entries(patch.dials)
      .filter(([k]) => DIAL_KEYS.has(k))
      .map(([key, value]) => ({ key, value }));
    await writeAuthorDials(db, bookId, dials, ctx.settings["stats.display_min_appraisals"]);
    done.push("dials");
  }
  if (patch.release) {
    await setRelease(db, bookId, { kind: patch.release.kind, date: patch.release.date }, "author", ctx.now);
    done.push("release");
  }
  if (patch.cancelRelease) {
    if (await cancelRelease(db, bookId, patch.cancelRelease)) done.push("cancelRelease");
  }
  if (patch.embargoUntil !== undefined) {
    await db
      .update(books)
      .set({
        embargoUntil: patch.embargoUntil ? `${patch.embargoUntil}T00:00:00.000Z` : null,
        updatedAt: nowIso(),
      })
      .where(eq(books.id, bookId));
    done.push("embargoUntil");
  }
  if (patch.hidden !== undefined) {
    // Hidden is kept for audit, never deleted; showing it again passes the publication gate.
    const r = await setVisibility(db, bookId, patch.hidden ? "hidden" : "published");
    if (r.ok) done.push("hidden");
  }
  return done;
}

/** Books a set of profiles are credited on, for the dashboard's ownership checks. */
export async function bookIdsFor(db: Db, authorIds: string[]): Promise<string[]> {
  if (authorIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: bookAuthors.bookId })
    .from(bookAuthors)
    .where(inArray(bookAuthors.authorId, authorIds.slice(0, 90)));
  return rows.map((r) => r.id);
}

/** A book as the edit form shows it, so a submitted form can be reduced to what actually changed. */
export interface Editable {
  title: string;
  subtitle: string | null;
  series: { name: string; position?: number } | null;
  blurb: string | null;
  kindleUnlimited: boolean;
  narrators: string[];
  tags: string[];
  dials: Record<string, number>;
  crunchLevel: number | null;
  romanceLevel: number | null;
  harem: string;
  contentFlags: string[];
  aiUse: string;
  embargoUntil: string | null;
}

export async function editableBook(db: Db, bookId: string): Promise<Editable | null> {
  const [b] = await db
    .select({ book: books, seriesName: seriesTable.name })
    .from(books)
    .leftJoin(seriesTable, eq(seriesTable.id, books.seriesId))
    .where(eq(books.id, bookId));
  if (!b) return null;
  const [eds, shown, scores] = await Promise.all([
    db.select().from(editions).where(eq(editions.bookId, bookId)),
    db
      .select({ slug: tags.slug, facet: tags.facet })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(and(eq(bookTags.bookId, bookId), gte(bookTags.score, 0.5))),
    db
      .select({ key: bookScores.key, authorValue: bookScores.authorValue })
      .from(bookScores)
      .where(and(eq(bookScores.bookId, bookId), eq(bookScores.kind, "dial"))),
  ]);
  const audio = eds.find((e) => e.format === "audiobook");
  const narrators = audio
    ? (
        await db
          .select({ name: narrators_.name })
          .from(editionNarrators)
          .innerJoin(narrators_, eq(narrators_.id, editionNarrators.narratorId))
          .where(eq(editionNarrators.editionId, audio.id))
          .orderBy(editionNarrators.position)
      ).map((n) => n.name)
    : [];
  const book = b.book;
  return {
    title: book.title,
    subtitle: book.subtitle,
    series: b.seriesName
      ? { name: b.seriesName, ...(book.seriesPosition !== null ? { position: book.seriesPosition } : {}) }
      : null,
    blurb: book.blurbAuthor,
    kindleUnlimited: eds.some((e) => e.format === "ebook" && e.kindleUnlimited),
    narrators,
    tags: shown
      .filter((t) => t.facet !== "genre")
      .map((t) => t.slug)
      .sort(),
    dials: Object.fromEntries(
      scores.filter((s) => s.authorValue !== null).map((s) => [s.key, s.authorValue as number]),
    ),
    crunchLevel: book.crunchLevel,
    romanceLevel: book.romanceLevel,
    harem: book.harem,
    contentFlags: [...(book.contentFlags ?? [])].sort(),
    aiUse: book.isAiGenerated,
    embargoUntil: book.embargoUntil ? book.embargoUntil.slice(0, 10) : null,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Keep only what differs from the book now: an untouched field must never become a change. */
export function diffEdit(current: Editable, next: EditPatch): EditPatch {
  const out: EditPatch = {};
  const put = <K extends keyof EditPatch>(key: K, value: EditPatch[K]) => {
    out[key] = value;
  };
  if (next.title !== undefined && next.title !== current.title) put("title", next.title);
  if (next.subtitle !== undefined && (next.subtitle || null) !== current.subtitle)
    put("subtitle", next.subtitle || null);
  if (next.series !== undefined && !same(next.series, current.series)) put("series", next.series);
  if (next.blurb !== undefined && (next.blurb || null) !== current.blurb) put("blurb", next.blurb || null);
  if (next.kindleUnlimited !== undefined && next.kindleUnlimited !== current.kindleUnlimited)
    put("kindleUnlimited", next.kindleUnlimited);
  if (next.narrators !== undefined && !same(next.narrators, current.narrators))
    put("narrators", next.narrators);
  if (next.tags !== undefined && !same([...next.tags].sort(), current.tags)) put("tags", next.tags);
  if (next.dials !== undefined && !same(next.dials, current.dials)) put("dials", next.dials);
  if (next.crunchLevel !== undefined && next.crunchLevel !== current.crunchLevel)
    put("crunchLevel", next.crunchLevel);
  if (next.romanceLevel !== undefined && next.romanceLevel !== current.romanceLevel)
    put("romanceLevel", next.romanceLevel);
  if (next.harem !== undefined && next.harem !== current.harem) put("harem", next.harem);
  if (next.contentFlags !== undefined && !same([...next.contentFlags].sort(), current.contentFlags))
    put("contentFlags", next.contentFlags);
  if (next.aiUse !== undefined && next.aiUse !== current.aiUse) put("aiUse", next.aiUse);
  if (next.embargoUntil !== undefined && (next.embargoUntil || null) !== current.embargoUntil)
    put("embargoUntil", next.embargoUntil || null);
  for (const key of ["addLinks", "release", "cancelRelease", "hidden"] as const)
    if (next[key] !== undefined) put(key, next[key] as never);
  return out;
}
