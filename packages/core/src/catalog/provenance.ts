// Field provenance and precedence (DESIGN §6.2–6.4). Every write to a book field is appended to
// book_field_sources; the value on `books` is recomputed from all of them by these pure functions.

import type { FieldSource } from "../db/schema";

export type FieldClass =
  | "fact"
  | "blurb"
  | "summary"
  | "subjective"
  | "harem"
  | "content_flags"
  | "ai_attestation";

/** Scalar book fields that carry provenance, and how each one resolves. */
export const BOOK_FIELD_CLASSES = {
  title: "fact",
  subtitle: "fact",
  seriesId: "fact",
  seriesPosition: "fact",
  firstPublished: "fact",
  pageCount: "fact",
  wordCountEst: "fact",
  language: "fact",
  pubStatus: "fact",
  blurbAuthor: "blurb",
  summaryAi: "summary",
  hookAi: "summary",
  primaryGenre: "subjective",
  inScope: "subjective",
  crunchLevel: "subjective",
  romanceLevel: "subjective",
  harem: "harem",
  contentFlags: "content_flags",
  isAiGenerated: "ai_attestation",
} as const satisfies Record<string, FieldClass>;

export type BookField = keyof typeof BOOK_FIELD_CLASSES;

export interface SourcedValue {
  value: unknown;
  source: FieldSource;
  confidence?: number | null;
  /** ISO time; later wins within the same rank. */
  createdAt: string;
  id: string;
}

export interface Resolved {
  value: unknown;
  /** Which source won, or null when nothing applies (the field falls back to its default). */
  source: FieldSource | null;
}

const NOTHING: Resolved = { value: undefined, source: null };

/**
 * Facts: admin lock → verified author → API (and cited research) → unverified author → AI →
 * reader suggestion (DESIGN §6.4).
 */
const FACT_RANK: Record<FieldSource, number> = {
  admin: 6,
  author_verified: 5,
  api: 4,
  research: 4,
  author: 3,
  ai: 2,
  reader: 1,
  crowd: 1,
};

function newest(rows: SourcedValue[]): SourcedValue | undefined {
  let best: SourcedValue | undefined;
  for (const r of rows) {
    if (!best || r.createdAt > best.createdAt || (r.createdAt === best.createdAt && r.id > best.id)) best = r;
  }
  return best;
}

function byRank(rows: SourcedValue[], rank: Partial<Record<FieldSource, number>>): Resolved {
  let top = -1;
  for (const r of rows) top = Math.max(top, rank[r.source] ?? -1);
  if (top < 0) return NOTHING;
  const winner = newest(rows.filter((r) => (rank[r.source] ?? -1) === top));
  return winner ? { value: winner.value, source: winner.source } : NOTHING;
}

function latestFrom(rows: SourcedValue[], sources: FieldSource[]): SourcedValue | undefined {
  return newest(rows.filter((r) => sources.includes(r.source)));
}

const AUTHOR_WEIGHT = 0.7;

/**
 * Subjective fields: admin lock → crowd consensus → author, blended with the AI → AI.
 * Numeric levels blend 70/30 author/AI, because authors tend to under-report (DESIGN §6.3).
 */
function resolveSubjective(rows: SourcedValue[]): Resolved {
  const admin = latestFrom(rows, ["admin"]);
  if (admin) return { value: admin.value, source: "admin" };
  const crowd = latestFrom(rows, ["crowd"]);
  if (crowd) return { value: crowd.value, source: "crowd" };
  const author = latestFrom(rows, ["author_verified"]) ?? latestFrom(rows, ["author"]);
  const ai = latestFrom(rows, ["ai", "research"]);
  if (author && ai && typeof author.value === "number" && typeof ai.value === "number") {
    return {
      value: Math.round(AUTHOR_WEIGHT * author.value + (1 - AUTHOR_WEIGHT) * ai.value),
      source: author.source,
    };
  }
  if (author) return { value: author.value, source: author.source };
  if (ai) return { value: ai.value, source: ai.source };
  const reader = latestFrom(rows, ["reader", "api"]);
  return reader ? { value: reader.value, source: reader.source } : NOTHING;
}

const HAREM_CAUTION: Record<string, number> = { none: 0, implied: 1, harem: 2, reverse_harem: 2 };

/**
 * Harem is an exclusion filter, and exclusions are conservative (DESIGN §6.2): below an admin
 * lock or crowd consensus, the most cautious of the author's and the AI's answers wins.
 */
function resolveHarem(rows: SourcedValue[]): Resolved {
  const admin = latestFrom(rows, ["admin"]);
  if (admin) return { value: admin.value, source: "admin" };
  const crowd = latestFrom(rows, ["crowd"]);
  if (crowd) return { value: crowd.value, source: "crowd" };
  const candidates = [
    latestFrom(rows, ["author_verified"]) ?? latestFrom(rows, ["author"]),
    latestFrom(rows, ["ai", "research"]),
  ].filter(
    (r): r is SourcedValue => r !== undefined && typeof r.value === "string" && r.value in HAREM_CAUTION,
  );
  if (candidates.length === 0) {
    const any = latestFrom(rows, ["author_verified", "author", "ai", "research", "reader", "api"]);
    return any ? { value: any.value, source: any.source } : NOTHING;
  }
  const winner = candidates.reduce((a, b) =>
    (HAREM_CAUTION[b.value as string] ?? 0) > (HAREM_CAUTION[a.value as string] ?? 0) ? b : a,
  );
  return { value: winner.value, source: winner.source };
}

/** Content flags: admin lock → the union of every source's latest answer. The most cautious wins. */
function resolveContentFlags(rows: SourcedValue[]): Resolved {
  const admin = latestFrom(rows, ["admin"]);
  if (admin) return { value: admin.value, source: "admin" };
  const flags = new Set<string>();
  let source: FieldSource | null = null;
  for (const kind of [
    "author_verified",
    "author",
    "ai",
    "research",
    "crowd",
    "reader",
    "api",
  ] as FieldSource[]) {
    const latest = latestFrom(rows, [kind]);
    if (!latest || !Array.isArray(latest.value)) continue;
    for (const f of latest.value) if (typeof f === "string") flags.add(f);
    source ??= latest.source;
  }
  return source ? { value: [...flags].sort(), source } : NOTHING;
}

/**
 * AI-use attestation: admin lock → author attestation → crowd reports upheld by admin.
 * The AI alone never labels a book AI-generated (DESIGN §6.4, TAXONOMY §10).
 */
function resolveAiAttestation(rows: SourcedValue[]): Resolved {
  return byRank(rows, { admin: 3, author_verified: 2, author: 2, crowd: 1 });
}

export function resolveField(field: BookField, rows: SourcedValue[]): Resolved {
  switch (BOOK_FIELD_CLASSES[field]) {
    case "fact":
      return byRank(rows, FACT_RANK);
    case "blurb":
      // Licensed text from a verified author, or the owner. Never copied from anywhere else.
      return byRank(rows, { admin: 2, author_verified: 1 });
    case "summary":
      return byRank(rows, { admin: 2, ai: 1 });
    case "subjective":
      return resolveSubjective(rows);
    case "harem":
      return resolveHarem(rows);
    case "content_flags":
      return resolveContentFlags(rows);
    case "ai_attestation":
      return resolveAiAttestation(rows);
  }
}

// ---------------------------------------------------------------------------------------------
// Tag scores (DESIGN §6.2)

export interface TagEvidence {
  adminLocked: boolean;
  adminValue: number | null;
  aiConfidence: number | null;
  authorAsserted: boolean | null;
  crowdUp: number;
  crowdDown: number;
}

/** Pseudo-votes the prior is worth once the crowd takes over. */
const PRIOR_STRENGTH = 4;

function authorAiBlend(authorAsserted: boolean | null, aiConfidence: number | null): number | null {
  if (authorAsserted === null) return aiConfidence;
  const author = authorAsserted ? 0.9 : 0.1;
  return aiConfidence === null ? author : AUTHOR_WEIGHT * author + (1 - AUTHOR_WEIGHT) * aiConfidence;
}

export function resolveTagScore(e: TagEvidence, crowdMinVotes: number): number {
  if (e.adminLocked) return clamp01(e.adminValue ?? 0);
  const votes = e.crowdUp + e.crowdDown;
  const prior = authorAiBlend(e.authorAsserted, e.aiConfidence);
  if (votes >= crowdMinVotes) {
    const p = prior ?? 0.5;
    return clamp01((e.crowdUp + p * PRIOR_STRENGTH) / (votes + PRIOR_STRENGTH));
  }
  return clamp01(prior ?? 0);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));

/** How seed and import confidence labels map to tag confidence. */
export const CONFIDENCE_VALUES = { high: 0.85, medium: 0.65, low: 0.45 } as const;
export type ConfidenceLabel = keyof typeof CONFIDENCE_VALUES;
