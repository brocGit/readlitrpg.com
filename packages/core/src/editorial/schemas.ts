// Proposal schemas for editorial runs (DESIGN §7.1 rules 3–5, §7.5). The run validates with these
// before pushing (`pnpm editorial validate`), and the editorial API validates again with the same
// code, against the live taxonomy. Anything that drives behavior is an enumeration; free text is
// length-capped, checked for links and markup, and never rendered as HTML.

import { z } from "zod";
import { DO_NOT_FETCH } from "../catalog/normalize";
import { CONFIDENCE_VALUES } from "../catalog/provenance";
import { EDITORIAL_KINDS } from "../db/schema/editorial";
import {
  ACTIVE_TAG_SLUGS,
  CONTENT_FLAGS,
  crunchLevelFromDial,
  DIAL_KEYS,
  FACETS,
  GENRE_SLUGS,
  getTag,
  romanceLevelFromDial,
  STAT_KEYS,
} from "../taxonomy";

/** Bump when a proposal shape changes, so an old checkout can't push stale shapes. */
export const PROPOSAL_SCHEMA_VERSION = 1;

/** Most proposals per push request: applying one takes about a dozen D1 queries. */
export const PUSH_BATCH_MAX = 25;

export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const confidenceValue = (c: Confidence): number => CONFIDENCE_VALUES[c];

/** What a run can report about the input itself (DESIGN §7.5). */
export const ANOMALIES = [
  "instructions_in_text",
  "not_fiction",
  "not_in_scope",
  "possible_duplicate",
  "metadata_conflict",
  "explicit_content_unflagged",
  "blurb_mostly_marketing",
  "other",
] as const;
export type Anomaly = (typeof ANOMALIES)[number];

const confidence = z.enum(CONFIDENCE);
const id = z.string().min(1).max(40);

const LINKISH = /(https?:\/\/|www\.|\]\()/i;
const MARKUP = /<\/?[a-z!][^>]*>/i;

/** C0 control characters other than tab, newline and carriage return. */
const isControl = (ch: string) => {
  const code = ch.charCodeAt(0);
  return code < 32 && code !== 9 && code !== 10 && code !== 13;
};

/** Plain prose: no links, no markup, no control characters, and a word limit. */
function prose(maxChars: number, maxWords: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxChars)
    .refine((s) => !LINKISH.test(s), "no links in prose")
    .refine((s) => !MARKUP.test(s), "no markup in prose")
    .refine((s) => ![...s].some(isControl), "no control characters")
    .refine((s) => s.split(/\s+/).filter(Boolean).length <= maxWords, `at most ${maxWords} words`);
}

const shortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !MARKUP.test(s), "no markup");

const scale = <C extends z.ZodType<Confidence>>(keys: ReadonlySet<string>, what: string, conf: C) =>
  z
    .record(
      z.string(),
      z.object({
        value: z.union([z.number().int().min(0).max(10), z.literal("unknown")]),
        confidence: conf,
      }),
    )
    .refine((r) => Object.keys(r).every((k) => keys.has(k)), `unknown ${what} key`);

export const classifyProposalSchema = z
  .object({
    kind: z.literal("classify"),
    item_id: id,
    book_id: id,
    in_scope: z.enum(["yes", "borderline", "no"]),
    primary_genre: z.string().refine((g) => GENRE_SLUGS.has(g), "not a genre tag"),
    tags: z
      .array(
        z.object({
          slug: z.string().refine((s) => ACTIVE_TAG_SLUGS.has(s), "not an active tag"),
          confidence,
          evidence: shortText(200).pipe(z.string().min(1, "evidence is required")),
        }),
      )
      .max(30),
    crunch_level: z.object({
      value: z.union([z.number().int().min(0).max(3), z.literal("unknown")]),
      confidence,
    }),
    romance_level: z.object({
      value: z.union([z.number().int().min(0).max(4), z.literal("unknown")]),
      confidence,
    }),
    harem: z.object({
      value: z.enum(["none", "implied", "harem", "reverse_harem", "unknown"]),
      confidence,
    }),
    known_work: z.enum(["yes", "no"]),
    dials: scale(DIAL_KEYS, "dial", confidence),
    // Stats from model knowledge are capped at medium (DESIGN §7.5): readers judge how well a book
    // delivers, so a run never claims high confidence here.
    stats: scale(STAT_KEYS, "stat", z.enum(["low", "medium"])),
    content_flags: z
      .array(z.string().refine((f) => CONTENT_FLAGS.includes(f), "unknown content flag"))
      .max(10),
    summary: prose(450, 60).nullable(),
    hook: prose(180, 25).nullable(),
    anomalies: z.array(z.enum(ANOMALIES)).max(8),
    notes: shortText(500).optional(),
  })
  .strict();

export const dedupeProposalSchema = z
  .object({
    kind: z.literal("dedupe"),
    item_id: id,
    verdict: z.enum(["same_work", "different_work", "unsure"]),
    confidence,
    /** Which record should survive a merge, when the verdict is same_work. */
    keep_id: id.optional(),
    reasons: prose(400, 70),
  })
  .strict();

const citedUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith("https://"), "https only")
  .refine((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return !DO_NOT_FETCH.some((p) => p.test(host));
    } catch {
      return false;
    }
  }, "that site is on the do-not-fetch list (Amazon, Audible, Royal Road, Goodreads)");

export const researchProposalSchema = z
  .object({
    kind: z.literal("research"),
    item_id: id,
    book_id: id,
    verdict: z.enum(["confirmed", "not_found", "conflict"]),
    confidence,
    sources: z.array(z.object({ url: citedUrl, quote: shortText(300).optional() })).max(5),
    /** Facts the sources support. Applied only after the server has checked a source. */
    facts: z
      .object({
        title: z.string().trim().min(1).max(300).optional(),
        series_name: z.string().trim().min(1).max(200).optional(),
        series_position: z.number().min(0).max(1000).optional(),
        first_published: z
          .object({
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullable(),
            precision: z.enum(["day", "month", "quarter", "year", "tba"]),
          })
          .optional(),
        publisher: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    notes: shortText(500).optional(),
  })
  .strict();

export const MODERATION_CATEGORIES = [
  "spam",
  "off_topic",
  "promotional",
  "harassment",
  "hate",
  "sexual",
  "sexual_minors",
  "violence",
  "self_harm",
  "personal_data",
  "misinformation",
  "instructions_in_text",
  "other",
] as const;

export const moderateProposalSchema = z
  .object({
    kind: z.literal("moderate"),
    item_id: id,
    verdict: z.enum(["allow", "review", "block"]),
    categories: z.array(z.enum(MODERATION_CATEGORIES)).max(6),
    reasons: prose(400, 70).optional(),
  })
  .strict();

export const IMAGE_CATEGORIES = [
  "nudity",
  "sexual",
  "gore",
  "hate_symbol",
  "text_claims",
  "not_a_cover",
  "low_quality",
  "other",
] as const;

export const imageReviewProposalSchema = z
  .object({
    kind: z.literal("image_review"),
    item_id: id,
    verdict: z.enum(["allow", "review", "block"]),
    categories: z.array(z.enum(IMAGE_CATEGORIES)).max(6),
    reasons: prose(400, 70).optional(),
  })
  .strict();

/**
 * "Paste anything" (DESIGN §10.3 step 0, §7.15 source 7): the books in an author's pasted text,
 * as drafts the author confirms. Titles, links and blurbs must come from the pasted text itself:
 * the server drops anything that isn't in it, so nothing is added from memory.
 */
export const importExtractProposalSchema = z
  .object({
    kind: z.literal("import_extract"),
    item_id: id,
    paste_id: id,
    books: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            series_name: z.string().trim().min(1).max(200).optional(),
            series_position: z.number().min(0).max(1000).optional(),
            coauthors: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
            genre: z
              .string()
              .refine((g) => GENRE_SLUGS.has(g), "not a genre")
              .optional(),
            blurb: shortText(3_000).optional(),
            links: z.array(z.string().trim().url().max(2_000)).max(10).optional(),
            releases: z
              .array(
                z.object({
                  kind: z.enum(["ebook", "audio", "print"]),
                  date: z.string().trim().min(1).max(40),
                }),
              )
              .max(3)
              .optional(),
          })
          .strict(),
      )
      .max(50),
    anomalies: z.array(z.enum(ANOMALIES)).max(5),
    notes: shortText(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Content kinds (M7, DESIGN §14)

const entityRef = z.object({ kind: z.enum(["book", "series", "author"]), id }).strict();

/**
 * The morning news scan (§14.6): short briefs about the genre found on the open web, each citing
 * at least one page the server will fetch. A brief about a catalog book, series or author names it
 * in `subjects`; the server publishes it only when a cited page mentions that subject.
 */
export const newsScanProposalSchema = z
  .object({
    kind: z.literal("news_scan"),
    item_id: id,
    briefs: z
      .array(
        z
          .object({
            headline: prose(120, 20),
            // Plain prose; catalog books may appear as [[book:ID]] (they become live links).
            body: prose(700, 120),
            sources: z
              .array(z.object({ url: citedUrl, title: shortText(200).optional() }).strict())
              .min(1)
              .max(3),
            subjects: z.array(entityRef).max(5),
            tip_ids: z.array(id).max(5).optional(),
            confidence,
          })
          .strict(),
      )
      .max(8),
    notes: shortText(500).optional(),
  })
  .strict();

/** A guide built from our data (§14.1 "Editorial draft", §14.4): sections of catalog books. */
export const postDraftProposalSchema = z
  .object({
    kind: z.literal("post_draft"),
    item_id: id,
    topic_key: z.string().trim().min(1).max(120),
    title: prose(120, 20),
    dek: prose(240, 45),
    sections: z
      .array(
        z
          .object({
            heading: prose(100, 14),
            // Markdown-free prose; books only as [[book:ID]].
            intro_md: z
              .string()
              .trim()
              .max(1_200)
              .refine((t) => !LINKISH.test(t), "no links")
              .refine((t) => !MARKUP.test(t), "no markup"),
            book_ids: z.array(id).min(1).max(15),
          })
          .strict(),
      )
      .min(2)
      .max(8),
    outro_md: shortText(800).refine((t) => !LINKISH.test(t), "no links"),
  })
  .strict();

export const GUEST_CHECKS = [
  "on_topic",
  "promotional",
  "spoilers_unmarked",
  "attacks_others",
  "ai_undisclosed",
  "affiliate_links",
  "too_short",
  "too_long",
  "other",
] as const;

/** Pre-review of a guest pitch or post (§14.3 step 2 and 5): a checklist for the owner. */
export const guestReviewProposalSchema = z
  .object({
    kind: z.literal("guest_review"),
    item_id: id,
    stage: z.enum(["pitch", "post"]),
    verdict: z.enum(["approve", "changes", "decline"]),
    issues: z.array(z.enum(GUEST_CHECKS)).max(8),
    self_promo_mentions: z.number().int().min(0).max(50),
    summary: prose(400, 70),
    suggested_title: prose(120, 20).optional(),
    suggested_dek: prose(240, 45).optional(),
  })
  .strict();

/** An author's interview answers, ordered, with a headline, a short intro and typo fixes only (§14.5). */
export const interviewFormatProposalSchema = z
  .object({
    kind: z.literal("interview_format"),
    item_id: id,
    headline: prose(110, 18),
    intro: prose(320, 55),
    order: z.array(z.string().min(1).max(40)).min(3).max(15),
    fixes: z.record(z.string().max(40), z.string().max(4_000)).optional(),
  })
  .strict();

export const proposalSchema = z.discriminatedUnion("kind", [
  classifyProposalSchema,
  dedupeProposalSchema,
  researchProposalSchema,
  moderateProposalSchema,
  imageReviewProposalSchema,
  importExtractProposalSchema,
  newsScanProposalSchema,
  postDraftProposalSchema,
  guestReviewProposalSchema,
  interviewFormatProposalSchema,
]);

export type ClassifyProposal = z.infer<typeof classifyProposalSchema>;
export type DedupeProposal = z.infer<typeof dedupeProposalSchema>;
export type ResearchProposal = z.infer<typeof researchProposalSchema>;
export type ModerateProposal = z.infer<typeof moderateProposalSchema>;
export type ImageReviewProposal = z.infer<typeof imageReviewProposalSchema>;
export type ImportExtractProposal = z.infer<typeof importExtractProposalSchema>;
export type NewsScanProposal = z.infer<typeof newsScanProposalSchema>;
export type PostDraftProposal = z.infer<typeof postDraftProposalSchema>;
export type GuestReviewProposal = z.infer<typeof guestReviewProposalSchema>;
export type InterviewFormatProposal = z.infer<typeof interviewFormatProposalSchema>;
export type Proposal = z.infer<typeof proposalSchema>;

// ---------------------------------------------------------------------------------------------
// Consistency rules the schema can't express (DESIGN §7.3 step 5).

const TONE_MAX = FACETS.find((f) => f.key === "tone")?.max ?? 3;
const HAREMISH = new Set(["implied", "harem", "reverse_harem"]);

export function classifyConsistency(p: ClassifyProposal): string[] {
  const errors: string[] = [];
  const slugs = p.tags.map((t) => t.slug);
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupes.length) errors.push(`tags: listed twice: ${[...new Set(dupes)].join(", ")}`);
  const tones = slugs.filter((s) => getTag(s)?.facet === "tone");
  if (tones.length > TONE_MAX) errors.push(`tags: at most ${TONE_MAX} tone tags (got ${tones.length})`);

  const romance = p.romance_level.value;
  if (HAREMISH.has(p.harem.value) && romance === 0) {
    errors.push("harem: a harem needs romance_level ≥ 1");
  }
  const crunchDial = p.dials.crunch?.value;
  if (typeof crunchDial === "number" && p.crunch_level.value !== "unknown") {
    const bucket = crunchLevelFromDial(crunchDial);
    if (bucket !== p.crunch_level.value) {
      errors.push(
        `crunch_level: ${p.crunch_level.value} disagrees with the crunch dial ${crunchDial} (level ${bucket})`,
      );
    }
  }
  const romanceDial = p.dials.romance?.value;
  if (typeof romanceDial === "number" && romance !== "unknown") {
    const bucket = romanceLevelFromDial(romanceDial);
    if (bucket !== romance) {
      errors.push(
        `romance_level: ${romance} disagrees with the romance dial ${romanceDial} (level ${bucket})`,
      );
    }
  }
  if (p.in_scope === "no" && !p.anomalies.includes("not_in_scope")) {
    errors.push("anomalies: in_scope 'no' must also report not_in_scope");
  }
  return errors;
}

export function researchConsistency(p: ResearchProposal): string[] {
  const errors: string[] = [];
  if (p.verdict !== "not_found" && p.sources.length === 0) {
    errors.push("sources: a confirmed or conflicting record needs at least one cited source");
  }
  if (p.verdict === "not_found" && p.facts) errors.push("facts: a record that wasn't found has no facts");
  return errors;
}

export function dedupeConsistency(p: DedupeProposal): string[] {
  return p.keep_id && p.verdict !== "same_work" ? ["keep_id: only for same_work"] : [];
}

export function newsScanConsistency(p: NewsScanProposal): string[] {
  const errors: string[] = [];
  p.briefs.forEach((b, i) => {
    const named = new Set(b.subjects.filter((s) => s.kind === "book").map((s) => s.id));
    for (const m of b.body.matchAll(/\[\[book:([^\]]{1,40})\]\]/g))
      if (!named.has(m[1] ?? "")) errors.push(`briefs.${i}.body: [[book:${m[1]}]] must also be in subjects`);
  });
  return errors;
}

export function interviewConsistency(p: InterviewFormatProposal): string[] {
  const dupes = p.order.filter((k, i) => p.order.indexOf(k) !== i);
  const sentences = p.intro.split(/[.!?]+\s/).filter(Boolean).length;
  return [
    ...(dupes.length ? [`order: listed twice: ${[...new Set(dupes)].join(", ")}`] : []),
    ...(sentences > 2 ? ["intro: at most two sentences"] : []),
    ...Object.keys(p.fixes ?? {})
      .filter((k) => !p.order.includes(k))
      .map((k) => `fixes.${k}: not in order`),
  ];
}

export type Validation = { ok: true; proposal: Proposal } | { ok: false; errors: string[] };

/** Parse and check one proposal. The same function runs in the CLI and in the editorial API. */
export function validateProposal(raw: unknown): Validation {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 20)
        .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`),
    };
  }
  const p = parsed.data;
  const errors =
    p.kind === "classify"
      ? classifyConsistency(p)
      : p.kind === "research"
        ? researchConsistency(p)
        : p.kind === "dedupe"
          ? dedupeConsistency(p)
          : p.kind === "news_scan"
            ? newsScanConsistency(p)
            : p.kind === "interview_format"
              ? interviewConsistency(p)
              : [];
  return errors.length ? { ok: false, errors } : { ok: true, proposal: p };
}

/** The item a proposal answers, for error messages when it doesn't parse. */
export function proposalItemId(raw: unknown): string | null {
  const v = (raw as { item_id?: unknown } | null)?.item_id;
  return typeof v === "string" ? v.slice(0, 40) : null;
}

export const pushRequestSchema = z.object({
  run_id: id,
  schema_version: z.literal(PROPOSAL_SCHEMA_VERSION),
  proposals: z.array(z.unknown()).min(1).max(PUSH_BATCH_MAX),
});

export const pullRequestSchema = z.object({
  run_id: id,
  kinds: z
    // Every kind the queue holds: a hand-kept list here once left a new kind unpullable.
    .array(z.enum(EDITORIAL_KINDS))
    .min(1)
    .max(EDITORIAL_KINDS.length),
  limit: z.number().int().min(1).max(1000),
});

export const startRunSchema = z.object({
  kind: z.enum(["daily", "weekly", "monthly", "manual"]),
  label: z.string().trim().max(100).optional(),
  skills: z.record(z.string().max(60), z.string().max(40)).optional(),
});

export const finishRunSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  notes: z.string().trim().max(2000).optional(),
});
