// Dials and book stats (DESIGN §6.6–6.7). Each key keeps its evidence per source; `value`,
// `confidence` and `public` are recomputed from it. M3's appraisals add crowd evidence through the
// same resolver.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { bookScores } from "../db/schema";
import { DIAL_KEYS, STAT_KEYS, STATS } from "../taxonomy";
import { nowIso } from "../time";

export interface ScoreEvidence {
  aiValue: number | null;
  aiConfidence: number | null;
  authorValue: number | null;
  crowdMean: number | null;
  crowdN: number;
}

export interface ResolvedScore {
  value: number | null;
  confidence: number | null;
}

/** Authors lean optimistic, so their sliders nudge the AI's prior and never decide (§6.6). */
const AUTHOR_NUDGE = 0.2;
/** Pseudo-count for the prior: after about ten appraisals readers dominate. */
const CROWD_PRIOR_N = 5;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function resolveScore(e: ScoreEvidence): ResolvedScore {
  let prior: number | null = null;
  let priorConfidence = 0;
  if (e.aiValue !== null && e.authorValue !== null) {
    prior = (1 - AUTHOR_NUDGE) * e.aiValue + AUTHOR_NUDGE * e.authorValue;
    priorConfidence = e.aiConfidence ?? 0.45;
  } else if (e.aiValue !== null) {
    prior = e.aiValue;
    priorConfidence = e.aiConfidence ?? 0.45;
  } else if (e.authorValue !== null) {
    prior = e.authorValue;
    priorConfidence = 0.4;
  }
  if (e.crowdN > 0 && e.crowdMean !== null) {
    const w = e.crowdN / (e.crowdN + CROWD_PRIOR_N);
    const value = prior === null ? e.crowdMean : (1 - w) * prior + w * e.crowdMean;
    return { value: round1(value), confidence: round3(1 - (1 - priorConfidence) * (1 - w)) };
  }
  return prior === null
    ? { value: null, confidence: null }
    : { value: round1(prior), confidence: round3(priorConfidence) };
}

const STAT_TYPE = new Map(STATS.map((s) => [s.key, s.type]));

/**
 * Who may see a score (§6.7): dials once they have a value; descriptive stats as an "Estimated"
 * value at medium confidence or better; judgment stats only after enough reader appraisals.
 */
export function isScorePublic(
  kind: "dial" | "stat",
  key: string,
  resolved: ResolvedScore,
  crowdN: number,
  minAppraisals: number,
): boolean {
  if (resolved.value === null) return false;
  if (kind === "dial") return true;
  if (STAT_TYPE.get(key) === "judgment") return crowdN >= minAppraisals;
  return (resolved.confidence ?? 0) >= 0.6 || crowdN >= minAppraisals;
}

export interface AiScoreWrite {
  key: string;
  /** null clears the AI's opinion ("unknown"). */
  value: number | null;
  confidence: number | null;
}

/** Record the AI's dial and stat estimates for a book and recompute. Admin-locked keys keep their value. */
export async function writeAiScores(
  db: Db,
  bookId: string,
  writes: AiScoreWrite[],
  minAppraisals: number,
): Promise<number> {
  const valid = writes.filter((w) => DIAL_KEYS.has(w.key) || STAT_KEYS.has(w.key));
  if (valid.length === 0) return 0;
  const existing = await db
    .select()
    .from(bookScores)
    .where(
      and(
        eq(bookScores.bookId, bookId),
        inArray(
          bookScores.key,
          valid.map((w) => w.key),
        ),
      ),
    );
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const now = nowIso();
  const statements = [];
  for (const w of valid) {
    const kind: "dial" | "stat" = DIAL_KEYS.has(w.key) ? "dial" : "stat";
    const row = byKey.get(w.key);
    const evidence: ScoreEvidence = {
      aiValue: w.value,
      aiConfidence: w.value === null ? null : w.confidence,
      authorValue: row?.authorValue ?? null,
      crowdMean: row?.crowdMean ?? null,
      crowdN: row?.crowdN ?? 0,
    };
    if (row && row.aiValue === evidence.aiValue && row.aiConfidence === evidence.aiConfidence) continue;
    const locked = row?.adminLocked ?? false;
    const resolved = locked ? { value: row?.value ?? null, confidence: 1 } : resolveScore(evidence);
    const isPublic = locked || isScorePublic(kind, w.key, resolved, evidence.crowdN, minAppraisals);
    const values = {
      bookId,
      key: w.key,
      kind,
      value: resolved.value,
      confidence: resolved.confidence,
      aiValue: evidence.aiValue,
      aiConfidence: evidence.aiConfidence,
      authorValue: evidence.authorValue,
      crowdMean: evidence.crowdMean,
      crowdN: evidence.crowdN,
      adminLocked: locked,
      public: isPublic,
      updatedAt: now,
    };
    statements.push(
      db
        .insert(bookScores)
        .values(values)
        .onConflictDoUpdate({
          target: [bookScores.bookId, bookScores.key],
          set: {
            value: values.value,
            confidence: values.confidence,
            aiValue: values.aiValue,
            aiConfidence: values.aiConfidence,
            public: values.public,
            updatedAt: now,
          },
        }),
    );
  }
  if (statements.length) await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return statements.length;
}
