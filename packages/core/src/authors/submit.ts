// Author book submissions (DESIGN §10.3, §7.6). The form becomes a BookInput credited to the
// member's own profile. A read-only duplicate check runs first, so a submission never writes onto
// another author's book; then the publish policy decides: verified authors publish now, unverified
// ones wait in the Owner Inbox (the book is only created on approval), out-of-scope is refused.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { setVisibility } from "../catalog/confirm";
import { ingestBook } from "../catalog/ingest";
import type { BookInput } from "../catalog/input";
import { normalizeAsin, parseLink, titleKey } from "../catalog/normalize";
import { matchBook } from "../catalog/resolve";
import { writeAuthorDials } from "../catalog/scores";
import type { Db } from "../db";
import {
  AI_USE,
  authorSubmissions,
  authors,
  bookAuthors,
  books,
  HAREM,
  NARRATION,
  RELEASE_KINDS,
} from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import { decideListing, type InboxPlan, type TrustLevel } from "../policy";
import type { Settings } from "../settings";
import { CONTENT_FLAGS, DIAL_KEYS, GENRE_SLUGS } from "../taxonomy";
import { nowIso } from "../time";

const BORDERLINE_GENRES: ReadonlySet<string> = new Set(["adjacent-fantasy", "adjacent-scifi"]);

const text = (max: number) => z.string().trim().max(max);
const name = text(200).min(1);

/** The submission form, validated at the boundary. Dials are the author's optional sliders. */
export const submissionSchema = z.object({
  title: text(300).min(1),
  subtitle: text(300).optional(),
  series: z.object({ name, position: z.number().min(0).max(1000).optional() }).optional(),
  coAuthors: z.array(name).max(5).default([]),
  primaryGenre: z.string().refine((g) => GENRE_SLUGS.has(g), "pick a genre"),
  blurb: text(5_000).optional(),
  links: z.array(text(2_000).min(1)).max(10).default([]),
  releases: z
    .array(z.object({ kind: z.enum(RELEASE_KINDS), date: text(40).min(1) }))
    .max(6)
    .default([]),
  kindleUnlimited: z.boolean().default(false),
  narrators: z.array(name).max(10).default([]),
  narrationType: z.enum(NARRATION).optional(),
  tags: z.array(text(80).min(1)).max(20).default([]),
  dials: z.record(z.string(), z.number().min(0).max(10)).default({}),
  crunchLevel: z.number().int().min(0).max(3).optional(),
  romanceLevel: z.number().int().min(0).max(4).optional(),
  harem: z.enum(HAREM).default("unknown"),
  contentFlags: z
    .array(z.string().refine((f) => CONTENT_FLAGS.includes(f), "unknown content note"))
    .max(10)
    .default([]),
  /** The AI-use attestation (§10.3) is required: the AI never sets it (§6.4). */
  aiUse: z.enum(AI_USE).refine((v) => v !== "unknown", "tell readers how AI was used"),
  embargoUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type Submission = z.infer<typeof submissionSchema>;

export class SubmissionError extends Error {}

export function toBookInput(s: Submission, authorName: string): BookInput {
  const editions: NonNullable<BookInput["editions"]> = [];
  if (s.kindleUnlimited) editions.push({ format: "ebook", kindleUnlimited: true });
  if (s.narrators.length)
    editions.push({ format: "audiobook", narrators: s.narrators, narrationType: s.narrationType });
  return {
    title: s.title,
    subtitle: s.subtitle || undefined,
    authors: [
      { name: authorName, role: "author" },
      ...s.coAuthors.map((n) => ({ name: n, role: "coauthor" as const })),
    ],
    series: s.series,
    primaryGenre: s.primaryGenre,
    inScope: BORDERLINE_GENRES.has(s.primaryGenre) ? "borderline" : "yes",
    tags: s.tags.map((slug) => ({ slug, confidence: 1 })),
    crunchLevel: s.crunchLevel,
    romanceLevel: s.romanceLevel,
    harem: s.harem,
    contentFlags: s.contentFlags,
    isAiGenerated: s.aiUse,
    blurb: s.blurb || undefined,
    links: s.links,
    releases: s.releases,
    editions: editions.length ? editions : undefined,
  };
}

type Duplicate = "new" | "own_stub" | "same_work";

/** Is this book already in the catalog, and whose is it? Reads only. */
async function prematch(db: Db, input: BookInput, authorId: string) {
  const asins: string[] = [];
  const audibleAsins: string[] = [];
  for (const raw of input.links ?? []) {
    const r = parseLink(raw);
    if (!r.ok || !r.link.asin) continue;
    const asin = normalizeAsin(r.link.asin);
    if (!asin) continue;
    if (r.link.kind === "audible") audibleAsins.push(asin);
    else if (r.link.kind === "amazon") asins.push(asin);
  }
  const { match } = await matchBook(
    db,
    {
      asins,
      isbns: [],
      audibleAsins,
      authorIds: [authorId],
      titleKey: titleKey(input.title),
      title: input.title,
      seriesId: null,
      position: input.series?.position ?? null,
    },
    1, // exact matches only here; ingest opens "possible duplicate" items for near misses
  );
  if (!match) return { duplicate: "new" as Duplicate, bookId: null };
  const [own] = await db
    .select({ id: bookAuthors.bookId })
    .from(bookAuthors)
    .where(and(eq(bookAuthors.bookId, match.bookId), eq(bookAuthors.authorId, authorId)));
  return { duplicate: (own ? "own_stub" : "same_work") as Duplicate, bookId: match.bookId };
}

export interface SubmitContext {
  userId: string;
  authorId: string;
  settings: Settings;
  now?: Date;
}

export type SubmitResult =
  | { outcome: "published"; submissionId: string; bookId: string; reasons: string[] }
  | { outcome: "in_review"; submissionId: string; reasons: string[] }
  | { outcome: "rejected"; submissionId: string; reasons: string[] };

const submitterFor = (trust: TrustLevel) =>
  trust === "T2" ? "author_t2" : trust === "T1" ? "author_t1" : "author_t0";

export async function submitBook(
  db: Db,
  ctx: SubmitContext,
  raw: unknown,
  existingId?: string,
): Promise<SubmitResult> {
  const parsed = submissionSchema.safeParse(raw);
  if (!parsed.success) throw new SubmissionError(parsed.error.issues[0]?.message ?? "check the form");
  const s = parsed.data;
  const [author] = await db.select().from(authors).where(eq(authors.id, ctx.authorId));
  if (!author || author.redirectTo) throw new SubmissionError("no such author profile");
  const trust = author.trustLevel as TrustLevel;
  const input = toBookInput(s, author.name);
  const pre = await prematch(db, input, ctx.authorId);
  const linksOk = s.links.every((l) => parseLink(l).ok);
  const decision = decideListing({
    submitter: submitterFor(trust),
    inScope: input.inScope ?? "unknown",
    anomalies: [],
    duplicate: pre.duplicate,
    linksOk,
    coverOk: null,
    lowConfidenceTags: false,
    haremOrRomanceUnknown: s.harem === "unknown" || s.romanceLevel === undefined,
    autoPublish: ctx.settings["flags.auto_publish"],
    t0DefaultHours: ctx.settings["publish.t0_default_action_hours"],
    readerSuggestionDays: ctx.settings["publish.reader_suggestion_default_days"],
  });
  const now = ctx.now ?? new Date();
  const stamp = nowIso(now);
  const id = existingId ?? ulid();
  const payload = { ...s, duplicateOf: pre.duplicate === "same_work" ? pre.bookId : null } as Record<
    string,
    unknown
  >;
  const row = {
    authorId: ctx.authorId,
    userId: ctx.userId,
    source: "form" as const,
    payload,
    reasons: decision.reasons,
    submittedAt: stamp,
    updatedAt: stamp,
  };
  const save = async (
    status: "in_review" | "rejected" | "published",
    extra: Record<string, unknown> = {},
  ) => {
    if (existingId)
      await db
        .update(authorSubmissions)
        .set({ ...row, status, ...extra })
        .where(eq(authorSubmissions.id, id));
    else await db.insert(authorSubmissions).values({ id, ...row, status, createdAt: stamp, ...extra });
  };

  if (decision.outcome === "reject" || decision.outcome === "draft") {
    await save("rejected", { decidedAt: stamp });
    return { outcome: "rejected", submissionId: id, reasons: decision.reasons };
  }
  if (decision.outcome === "inbox") {
    await save("in_review");
    // A restricted profile (T-1) waits for the owner whatever the plan says (§2.2).
    const plan: InboxPlan =
      trust === "T-1" ? { ...decision.inbox, defaultAction: "none", afterHours: null } : decision.inbox;
    const item = await openInboxItem(db, {
      type: plan.type,
      title: `${plan.type === "listing_unverified" ? "New listing (unverified author)" : "Author submission"}: "${s.title}"`,
      subjectType: "submission",
      subjectId: id,
      priority: plan.priority,
      payload: {
        submissionId: id,
        authorId: ctx.authorId,
        authorName: author.name,
        title: s.title,
        series: s.series ?? null,
        genre: s.primaryGenre,
        links: s.links,
        releases: s.releases,
        aiUse: s.aiUse,
        duplicateOf: pre.duplicate === "same_work" ? pre.bookId : null,
        reasons: decision.reasons,
      },
      defaultAction: plan.defaultAction,
      defaultActionAt:
        plan.afterHours !== null
          ? new Date(now.getTime() + plan.afterHours * 3_600_000).toISOString()
          : undefined,
      dedupeKey: `submission:${id}`,
    });
    if (item)
      await db.update(authorSubmissions).set({ inboxItemId: item.id }).where(eq(authorSubmissions.id, id));
    return { outcome: "in_review", submissionId: id, reasons: decision.reasons };
  }

  await save("in_review");
  const bookId = await applySubmission(db, id, { settings: ctx.settings, now });
  if (decision.followUp) {
    await openInboxItem(db, {
      type: decision.followUp.type,
      title: `Check the tags on "${s.title}"`,
      subjectType: "book",
      subjectId: bookId,
      priority: decision.followUp.priority,
      payload: { bookId, reason: "the author left harem or the romance level unknown" },
      defaultAction: decision.followUp.defaultAction,
      defaultActionAt:
        decision.followUp.afterHours !== null
          ? new Date(now.getTime() + decision.followUp.afterHours * 3_600_000).toISOString()
          : undefined,
      dedupeKey: `tag_check:${bookId}`,
    });
  }
  return { outcome: "published", submissionId: id, bookId, reasons: decision.reasons };
}

/**
 * Create or update the book from a submission and publish it: straight away for verified authors,
 * or when the owner (or the inbox default) approves. The author's claim is the confirmation the
 * publication gate needs (§7.15), and the next editorial run reviews the tags.
 */
export async function applySubmission(
  db: Db,
  submissionId: string,
  opts: { settings: Settings; now?: Date },
): Promise<string> {
  const [sub] = await db.select().from(authorSubmissions).where(eq(authorSubmissions.id, submissionId));
  if (!sub) throw new SubmissionError("no such submission");
  if (sub.status === "published" && sub.bookId) return sub.bookId;
  const s = submissionSchema.parse(sub.payload);
  const [author] = await db.select().from(authors).where(eq(authors.id, sub.authorId));
  if (!author) throw new SubmissionError("the author profile is gone");
  const verified = author.trustLevel === "T1" || author.trustLevel === "T2";
  const result = await ingestBook(db, toBookInput(s, author.name), {
    source: verified ? "author_verified" : "author",
    origin: "author",
    sourceRef: `submission:${sub.id}`,
    actorId: sub.userId,
    confirmation: { source: "author_claim", ref: sub.id },
    fuzzyMin: opts.settings["catalog.fuzzy_title_min"],
    crowdMinVotes: opts.settings["tags.crowd_min_votes"],
    pinnedAuthorId: sub.authorId,
  });
  const dials = Object.entries(s.dials).map(([key, value]) => ({ key, value }));
  if (dials.some((d) => DIAL_KEYS.has(d.key)))
    await writeAuthorDials(db, result.bookId, dials, opts.settings["stats.display_min_appraisals"]);
  if (s.embargoUntil)
    await db
      .update(books)
      .set({ embargoUntil: `${s.embargoUntil}T00:00:00.000Z` })
      .where(eq(books.id, result.bookId));
  await setVisibility(db, result.bookId, "published");
  const stamp = nowIso(opts.now);
  await db
    .update(authorSubmissions)
    .set({ status: "published", bookId: result.bookId, decidedAt: stamp, updatedAt: stamp })
    .where(eq(authorSubmissions.id, submissionId));
  return result.bookId;
}

export async function rejectSubmission(
  db: Db,
  submissionId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(authorSubmissions)
    .set({
      status: "rejected",
      reasons: [reason.slice(0, 300)],
      decidedAt: nowIso(now),
      updatedAt: nowIso(now),
    })
    .where(and(eq(authorSubmissions.id, submissionId), eq(authorSubmissions.status, "in_review")))
    .returning({ id: authorSubmissions.id });
  return rows.length === 1;
}

export async function submissionsFor(db: Db, authorId: string) {
  return db
    .select()
    .from(authorSubmissions)
    .where(eq(authorSubmissions.authorId, authorId))
    .orderBy(authorSubmissions.createdAt)
    .limit(200);
}
