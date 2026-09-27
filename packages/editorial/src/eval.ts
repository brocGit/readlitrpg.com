// The classification eval harness (DESIGN §7.14). A run classifies the golden books blind
// (`pnpm editorial eval-input`), and this scores its proposals against the adjudicated labels.
// The gate protects what readers rely on most: exclusion filters never get worse.

import { type ClassifyProposal, validateProposal } from "@rlr/core/editorial";
import { DIALS, FACETS, getTag, TAGS } from "@rlr/core/taxonomy";
import { z } from "zod";

export const goldenEntrySchema = z.object({
  id: z.string().regex(/^g\d{3,4}$/),
  book: z.object({
    title: z.string().min(1),
    authors: z.array(z.string().min(1)).min(1),
    series: z.object({ name: z.string(), position: z.number().nullable() }).nullable().optional(),
    first_published: z.string().optional(),
  }),
  labels: z.object({
    in_scope: z.enum(["yes", "borderline", "no"]),
    primary_genre: z.string(),
    tags: z.array(z.string()),
    crunch_level: z.number().int().min(0).max(3),
    romance_level: z.number().int().min(0).max(4),
    harem: z.enum(["none", "implied", "harem", "reverse_harem"]),
    content_flags: z.array(z.string()),
    dials: z.record(z.string(), z.number().min(0).max(10)),
  }),
  /** Why each label is what it is: a citation or a short reason. */
  evidence: z.record(z.string(), z.string()).optional(),
  /** Why the book is in the set, for hard cases (harem-adjacent, cultivation vs LitRPG, …). */
  hard_case: z.string().optional(),
});
export type GoldenEntry = z.infer<typeof goldenEntrySchema>;

export function parseGolden(text: string): GoldenEntry[] {
  const entries = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const parsed = goldenEntrySchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`golden line ${i + 1}: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    });
  const ids = entries.map((e) => e.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`golden id ${dup} appears twice`);
  return entries;
}

/** Problems with the golden set itself: unknown slugs, keys or inconsistent levels. */
export function lintGolden(entries: GoldenEntry[]): string[] {
  const problems: string[] = [];
  const dialKeys = new Set(DIALS.map((d) => d.key));
  for (const e of entries) {
    for (const slug of [...e.labels.tags, e.labels.primary_genre]) {
      if (!getTag(slug)) problems.push(`${e.id}: unknown tag ${slug}`);
    }
    if (getTag(e.labels.primary_genre)?.facet !== "genre")
      problems.push(`${e.id}: primary_genre isn't a genre`);
    for (const key of Object.keys(e.labels.dials))
      if (!dialKeys.has(key)) problems.push(`${e.id}: unknown dial ${key}`);
    if (e.labels.harem !== "none" && e.labels.romance_level === 0)
      problems.push(`${e.id}: harem with romance 0`);
  }
  return problems;
}

/** The blind input a run classifies: what a submission would carry, no labels. */
export function evalWorkItems(entries: GoldenEntry[]) {
  return entries.map((e) => ({
    item_id: `eval-${e.id}`,
    kind: "classify" as const,
    priority: 0,
    attempts: 0,
    input: {
      book: {
        id: e.id,
        title: e.book.title,
        authors: e.book.authors,
        series: e.book.series ?? null,
        first_published: e.book.first_published ?? null,
      },
    },
  }));
}

const SHOWN = new Set(["medium", "high"]);
const EXCLUDABLE_TAGS = new Set(TAGS.filter((t) => t.commonly_excluded).map((t) => t.slug));

interface Prf {
  tp: number;
  fp: number;
  fn: number;
}
const prf = (c: Prf) => {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 1;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision: round(precision), recall: round(recall), f1: round(f1), support: c.tp + c.fn };
};
const round = (n: number) => Math.round(n * 1000) / 1000;

export interface EvalReport {
  books: number;
  answered: number;
  invalid: { id: string; errors: string[] }[];
  in_scope_accuracy: number;
  primary_genre_accuracy: number;
  harem_accuracy: number;
  facets: Record<string, ReturnType<typeof prf>>;
  macro_f1: number;
  exclusion: { recall: number; positives: number; missed: string[] };
  ordinal_mae: { crunch_level: number | null; romance_level: number | null };
  dial_mae: Record<string, { mae: number; n: number }>;
}

/** Exclusion signals a reader filters on (DESIGN §6.2): commonly excluded tags, harem, romance ≥ 3, content flags. */
function exclusionSignals(
  tags: string[],
  harem: string,
  romance: number | "unknown",
  flags: string[],
): Set<string> {
  const out = new Set<string>();
  for (const t of tags) if (EXCLUDABLE_TAGS.has(t)) out.add(`tag:${t}`);
  if (harem !== "none" && harem !== "unknown") out.add("harem");
  if (typeof romance === "number" && romance >= 3) out.add("romance>=3");
  for (const f of flags) out.add(`flag:${f}`);
  return out;
}

export function scoreEval(golden: GoldenEntry[], raws: unknown[]): EvalReport {
  const predictions = new Map<string, ClassifyProposal>();
  const invalid: EvalReport["invalid"] = [];
  for (const raw of raws) {
    const v = validateProposal(raw);
    const id = (raw as { book_id?: string })?.book_id ?? "?";
    if (!v.ok) invalid.push({ id, errors: v.errors.slice(0, 3) });
    else if (v.proposal.kind === "classify") predictions.set(v.proposal.book_id, v.proposal);
  }
  const facetCounts = new Map<string, Prf>(FACETS.map((f) => [f.key, { tp: 0, fp: 0, fn: 0 }]));
  let scopeOk = 0;
  let genreOk = 0;
  let haremOk = 0;
  let answered = 0;
  const excl = { tp: 0, positives: 0, missed: [] as string[] };
  const ordinal = { crunch: [] as number[], romance: [] as number[] };
  const dials = new Map<string, number[]>();

  for (const g of golden) {
    const p = predictions.get(g.id);
    const truthTags = new Set(g.labels.tags);
    const truthExcl = exclusionSignals(
      g.labels.tags,
      g.labels.harem,
      g.labels.romance_level,
      g.labels.content_flags,
    );
    excl.positives += truthExcl.size;
    if (!p) {
      for (const t of truthTags) {
        const facet = getTag(t)?.facet;
        const c = facet ? facetCounts.get(facet) : undefined;
        if (c) c.fn++;
      }
      excl.missed.push(...[...truthExcl].map((s) => `${g.id} ${s}`));
      continue;
    }
    answered++;
    if (p.in_scope === g.labels.in_scope) scopeOk++;
    if (p.primary_genre === g.labels.primary_genre) genreOk++;
    if (p.harem.value === g.labels.harem) haremOk++;

    const shown = new Set(p.tags.filter((t) => SHOWN.has(t.confidence)).map((t) => t.slug));
    for (const slug of new Set([...shown, ...truthTags])) {
      const facet = getTag(slug)?.facet;
      const c = facet ? facetCounts.get(facet) : undefined;
      if (!c) continue;
      if (shown.has(slug) && truthTags.has(slug)) c.tp++;
      else if (shown.has(slug)) c.fp++;
      else c.fn++;
    }
    // Exclusion filters match at any confidence (score ≥ 0.3), so low-confidence tags count here.
    const predictedExcl = exclusionSignals(
      p.tags.map((t) => t.slug),
      p.harem.value,
      p.romance_level.value,
      p.content_flags,
    );
    for (const s of truthExcl) {
      if (predictedExcl.has(s)) excl.tp++;
      else excl.missed.push(`${g.id} ${s}`);
    }
    if (p.crunch_level.value !== "unknown")
      ordinal.crunch.push(Math.abs(p.crunch_level.value - g.labels.crunch_level));
    if (p.romance_level.value !== "unknown")
      ordinal.romance.push(Math.abs(p.romance_level.value - g.labels.romance_level));
    for (const [key, truth] of Object.entries(g.labels.dials)) {
      const v = p.dials[key]?.value;
      if (typeof v === "number") dials.set(key, [...(dials.get(key) ?? []), Math.abs(v - truth)]);
    }
  }

  const facets = Object.fromEntries([...facetCounts].map(([k, c]) => [k, prf(c)]));
  const withSupport = Object.values(facets).filter((f) => f.support > 0);
  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const n = golden.length || 1;
  return {
    books: golden.length,
    answered,
    invalid,
    in_scope_accuracy: round(scopeOk / n),
    primary_genre_accuracy: round(genreOk / n),
    harem_accuracy: round(haremOk / n),
    facets,
    macro_f1: withSupport.length ? round(withSupport.reduce((a, f) => a + f.f1, 0) / withSupport.length) : 0,
    exclusion: {
      recall: excl.positives ? round(excl.tp / excl.positives) : 1,
      positives: excl.positives,
      missed: excl.missed,
    },
    ordinal_mae: { crunch_level: mean(ordinal.crunch), romance_level: mean(ordinal.romance) },
    dial_mae: Object.fromEntries([...dials].map(([k, xs]) => [k, { mae: mean(xs) ?? 0, n: xs.length }])),
  };
}

export interface Baseline {
  macro_f1: number;
  exclusion_recall: number;
  dial_mae: Record<string, number>;
  recorded_at: string;
  note?: string;
}

export function toBaseline(report: EvalReport, note?: string): Baseline {
  return {
    macro_f1: report.macro_f1,
    exclusion_recall: report.exclusion.recall,
    dial_mae: Object.fromEntries(Object.entries(report.dial_mae).map(([k, v]) => [k, v.mae])),
    recorded_at: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
}

/** The §7.14 gate: exclusion recall may not drop at all, macro-F1 by at most 2 points, dial MAE rise by at most 0.5. */
export function gate(report: EvalReport, baseline: Baseline): string[] {
  const failures: string[] = [];
  if (report.exclusion.recall < baseline.exclusion_recall) {
    failures.push(`exclusion recall fell from ${baseline.exclusion_recall} to ${report.exclusion.recall}`);
  }
  if (report.macro_f1 < baseline.macro_f1 - 0.02) {
    failures.push(`macro-F1 fell from ${baseline.macro_f1} to ${report.macro_f1}`);
  }
  for (const [key, before] of Object.entries(baseline.dial_mae)) {
    const now = report.dial_mae[key]?.mae;
    if (now !== undefined && now > before + 0.5)
      failures.push(`${key} dial error rose from ${before} to ${now}`);
  }
  if (report.invalid.length) failures.push(`${report.invalid.length} proposals failed validation`);
  return failures;
}

export function formatReport(report: EvalReport): string {
  const lines = [
    `Books: ${report.answered}/${report.books} answered${report.invalid.length ? `, ${report.invalid.length} invalid` : ""}`,
    `In scope: ${report.in_scope_accuracy} · primary genre: ${report.primary_genre_accuracy} · harem: ${report.harem_accuracy}`,
    `Exclusion recall: ${report.exclusion.recall} (${report.exclusion.positives} signals)`,
    `Macro-F1 (tags shown at medium+): ${report.macro_f1}`,
    `Ordinal MAE: crunch ${report.ordinal_mae.crunch_level ?? "-"} · romance ${report.ordinal_mae.romance_level ?? "-"}`,
    "",
    "Facet           P      R      F1     n",
    ...Object.entries(report.facets)
      .filter(([, f]) => f.support > 0)
      .map(
        ([k, f]) =>
          `${k.padEnd(15)} ${f.precision.toFixed(2)}   ${f.recall.toFixed(2)}   ${f.f1.toFixed(2)}   ${f.support}`,
      ),
    "",
    "Dial MAE: " +
      Object.entries(report.dial_mae)
        .map(([k, v]) => `${k} ${v.mae}`)
        .join(" · "),
  ];
  if (report.exclusion.missed.length) {
    lines.push("", "Missed exclusion signals:", ...report.exclusion.missed.slice(0, 30).map((m) => `  ${m}`));
  }
  return lines.join("\n");
}
