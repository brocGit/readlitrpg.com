// Discovery search (DESIGN §9.2 /find): include and exclude tags, dial ranges, formats, series
// status and hard no's, sorted by match, any dial, any public stat, newest or data quality.
// Runs over the feature matrix, so it costs the same few milliseconds as a match.

import { z } from "zod";
import { TAGS } from "../taxonomy";
import { dial, type FeatureMatrix, hasFormat, isKu, seriesStatus, stat, tagsOf } from "./matrix";
import { emptyProfile, HARD_NOS, type TasteProfile } from "./profile";
import { combine, components, DEFAULT_MATCH_OPTIONS, hardFilter, type MatchOptions } from "./score";

const TAG_SLUGS = new Set(TAGS.map((t) => t.slug));
const slug = z.string().refine((s) => TAG_SLUGS.has(s), "unknown tag");

export const findQuerySchema = z.object({
  include: z.array(slug).max(10).default([]),
  exclude: z.array(slug).max(10).default([]),
  dials: z.record(z.string(), z.tuple([z.number().min(0).max(10), z.number().min(0).max(10)])).default({}),
  formats: z
    .array(z.enum(["ebook", "audiobook", "print", "ku"]))
    .max(4)
    .default([]),
  status: z.enum(["complete", "ongoing", "any"]).default("any"),
  noes: z.array(z.enum(HARD_NOS)).max(HARD_NOS.length).default([]),
  sort: z
    .string()
    .regex(/^(match|quality|newest|(dial|stat):[a-z_]+(:(asc|desc))?)$/)
    .default("quality"),
  page: z.number().int().min(1).max(50).default(1),
});
export type FindQuery = z.infer<typeof findQuerySchema>;

/** `/find?inc=cozy,crafting&exc=grimdark&d.pacing=6-10&fmt=audiobook&status=complete&no=harem&sort=dial:pacing:desc` */
export function parseFindParams(params: URLSearchParams): FindQuery {
  const list = (key: string) =>
    (params.get(key) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const dials: Record<string, [number, number]> = {};
  for (const [key, value] of params) {
    const m = /^d\.([a-z_]+)$/.exec(key);
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(value);
    if (m?.[1] && range) dials[m[1]] = [Number(range[1]), Number(range[2])];
  }
  const parsed = findQuerySchema.safeParse({
    include: list("inc").filter((s) => TAG_SLUGS.has(s)),
    exclude: list("exc").filter((s) => TAG_SLUGS.has(s)),
    dials,
    formats: list("fmt").filter((f) => ["ebook", "audiobook", "print", "ku"].includes(f)),
    status: params.get("status") ?? undefined,
    noes: list("no").filter((n) => (HARD_NOS as readonly string[]).includes(n)),
    sort: params.get("sort") ?? undefined,
    page: params.get("page") ? Number(params.get("page")) : undefined,
  });
  return parsed.success ? parsed.data : findQuerySchema.parse({});
}

export function findParams(q: FindQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.include.length) p.set("inc", q.include.join(","));
  if (q.exclude.length) p.set("exc", q.exclude.join(","));
  for (const [k, [lo, hi]] of Object.entries(q.dials)) p.set(`d.${k}`, `${lo}-${hi}`);
  if (q.formats.length) p.set("fmt", q.formats.join(","));
  if (q.status !== "any") p.set("status", q.status);
  if (q.noes.length) p.set("no", q.noes.join(","));
  if (q.sort !== "quality") p.set("sort", q.sort);
  if (q.page > 1) p.set("page", String(q.page));
  return p;
}

export const FIND_PAGE_SIZE = 24;

export interface FindHit {
  i: number;
  /** The value sorted on (a dial, a stat, a score, a year), for display. */
  value: number | null;
}

/** Hard no's reuse the match engine's conservative exclusion rules. */
function noesProfile(q: FindQuery): TasteProfile {
  const p = emptyProfile();
  for (const no of q.noes) {
    if (no === "harem") p.exclude.harem = true;
    else if (no === "heavy_romance") p.exclude.romanceMax = 2;
    else if (no === "explicit") p.exclude.flags.push("explicit-sex");
    else if (no === "gore") p.exclude.flags.push("gore");
    else if (no === "sexual_violence") p.exclude.flags.push("sexual-violence");
    else if (no === "grimdark") p.exclude.tags.push("grimdark");
    else if (no === "horror") p.exclude.tags.push("horror");
    else if (no === "villain_mc") p.exclude.tags.push("villain-mc");
    else if (no === "ai_generated") p.exclude.aiGenerated = true;
    else if (no === "unfinished") p.exclude.unfinished = true;
  }
  p.exclude.tags.push(...q.exclude);
  p.require.formats = q.formats;
  return p;
}

export function findBooks(
  m: FeatureMatrix,
  q: FindQuery,
  profile: TasteProfile | null = null,
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): { total: number; hits: FindHit[] } {
  const filters = noesProfile(q);
  const includeIdx = q.include.map((s) => m.tags.indexOf(s)).filter((t) => t >= 0);
  const hits: FindHit[] = [];
  const [kind, key, dir] = q.sort.split(":");
  const dialIndex = kind === "dial" ? m.dials.indexOf(key ?? "") : -1;
  const statIndex = kind === "stat" ? m.stats.indexOf(key ?? "") : -1;
  for (let i = 0; i < m.n; i++) {
    if (hardFilter(m, i, filters, opts)) continue;
    const tags = tagsOf(m, i);
    if (includeIdx.some((t) => (tags.get(t) ?? 0) < opts.includeMin)) continue;
    let inRange = true;
    for (const [k, [lo, hi]] of Object.entries(q.dials)) {
      const d = m.dials.indexOf(k);
      if (d < 0) continue;
      const x = dial(m, i, d);
      // A range asks for books we know are in it.
      if (x.value === null || x.value < lo || x.value > hi) inRange = false;
    }
    if (!inRange) continue;
    if (q.status !== "any") {
      const s = seriesStatus(m, i);
      if (q.status === "complete" && m.seriesIdx[i] !== -1 && s !== "complete") continue;
      if (q.status === "ongoing" && s !== "ongoing") continue;
    }
    if (q.formats.length && !q.formats.some((f) => (f === "ku" ? isKu(m, i) : hasFormat(m, i, f)))) continue;
    let value: number | null = null;
    if (kind === "match" && profile) value = combine(components(m, i, profile, opts), opts.weights);
    else if (kind === "newest") value = m.year[i] || null;
    else if (dialIndex >= 0) value = dial(m, i, dialIndex).value;
    else if (statIndex >= 0) {
      // Sorting by a stat uses only values readers can see (§6.7).
      const x = stat(m, i, statIndex);
      value = x.public ? x.value : null;
    } else value = (m.quality[i] ?? 0) / 100;
    hits.push({ i, value });
  }
  const asc = dir === "asc";
  hits.sort((a, b) => {
    if (a.value === null && b.value === null)
      return (m.quality[b.i] ?? 0) - (m.quality[a.i] ?? 0) || a.i - b.i;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return (
      (asc ? a.value - b.value : b.value - a.value) ||
      (m.quality[b.i] ?? 0) - (m.quality[a.i] ?? 0) ||
      a.i - b.i
    );
  });
  const start = (q.page - 1) * FIND_PAGE_SIZE;
  return { total: hits.length, hits: hits.slice(start, start + FIND_PAGE_SIZE) };
}
