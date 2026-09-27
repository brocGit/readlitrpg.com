// The controlled vocabulary (DESIGN §6). data/taxonomy.yaml is the source; scripts/taxonomy-build.mjs
// validates it and generates taxonomy.gen.ts. syncTaxonomy() writes it into the `tags` table.

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { tags } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { TAXONOMY_DATA, TAXONOMY_HASH } from "./taxonomy.gen";

export { TAXONOMY_HASH };

export interface TagDef {
  slug: string;
  name: string;
  facet: string;
  definition: string;
  include_when?: string;
  examples?: string;
  synonyms?: readonly string[];
  commonly_excluded?: boolean;
  status?: "active" | "proposed" | "retired";
  replaced_by?: string;
  parent?: string;
}

export interface FacetDef {
  key: string;
  name: string;
  multi: boolean;
  max?: number;
  note?: string;
}

export interface ScaleDef {
  key: string;
  name: string;
  anchors: Readonly<Record<"0" | "5" | "10", string>>;
}

export interface StatDef extends ScaleDef {
  type: "judgment" | "descriptive";
}

export const FACETS = TAXONOMY_DATA.facets as readonly FacetDef[];
export const TAGS = TAXONOMY_DATA.tags as readonly TagDef[];
export const DIALS = TAXONOMY_DATA.dials as readonly ScaleDef[];
export const STATS = TAXONOMY_DATA.stats as readonly StatDef[];
export const CONTENT_FLAG_DEFS = TAXONOMY_DATA.content_flags as readonly {
  slug: string;
  name: string;
  definition: string;
}[];
export const CONTENT_FLAGS = TAXONOMY_DATA.content_flags.map((f) => f.slug) as readonly string[];
export const HAREM_VALUES = TAXONOMY_DATA.harem.map((h) => h.value) as readonly string[];
export const CRUNCH_LEVELS = TAXONOMY_DATA.crunch_levels as readonly { value: number; label: string }[];
export const ROMANCE_LEVELS = TAXONOMY_DATA.romance_levels as readonly { value: number; label: string }[];

const tagBySlug = new Map(TAGS.map((t) => [t.slug, t]));
export const ACTIVE_TAG_SLUGS: ReadonlySet<string> = new Set(
  TAGS.filter((t) => (t.status ?? "active") === "active").map((t) => t.slug),
);
export const GENRE_SLUGS: ReadonlySet<string> = new Set(
  TAGS.filter((t) => t.facet === "genre").map((t) => t.slug),
);
export const DIAL_KEYS: ReadonlySet<string> = new Set(DIALS.map((d) => d.key));
export const STAT_KEYS: ReadonlySet<string> = new Set(STATS.map((s) => s.key));

export function getTag(slug: string): TagDef | undefined {
  return tagBySlug.get(slug);
}

/** Follow retirements to the tag that replaced it (retired tags redirect; DESIGN §6.5). */
export function canonicalTagSlug(slug: string): string | null {
  let current = tagBySlug.get(slug);
  for (let hops = 0; current && hops < 5; hops++) {
    if ((current.status ?? "active") !== "retired") return current.slug;
    current = current.replaced_by ? tagBySlug.get(current.replaced_by) : undefined;
  }
  return null;
}

/** Find a tag by slug, name or synonym, for import columns and search ("Xianxia" → cultivation). */
export function findTag(term: string): TagDef | undefined {
  const t = term.trim().toLowerCase();
  const direct = tagBySlug.get(t) ?? tagBySlug.get(t.replace(/\s+/g, "-"));
  if (direct) return direct;
  return TAGS.find(
    (tag) => tag.name.toLowerCase() === t || (tag.synonyms ?? []).some((s) => s.toLowerCase() === t),
  );
}

/** `crunch_level` is a bucketed view of the `crunch` dial (TAXONOMY §6). */
export function crunchLevelFromDial(value: number): number {
  if (value <= 1) return 0;
  if (value <= 4) return 1;
  if (value <= 7) return 2;
  return 3;
}

/** `romance_level` is a bucketed view of the `romance` dial (TAXONOMY §7a). */
export function romanceLevelFromDial(value: number): number {
  if (value <= 0) return 0;
  if (value <= 2) return 1;
  if (value <= 5) return 2;
  if (value <= 8) return 3;
  return 4;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Upsert every tag from the YAML into `tags`. Never deletes: tags removed from the YAML must be
 * retired there instead. Rows that exist only in the database (proposals) are left alone.
 */
export async function syncTaxonomy(db: Db): Promise<SyncResult> {
  const existing = await db.select().from(tags);
  const bySlug = new Map(existing.map((t) => [t.slug, t]));
  const now = nowIso();
  const result: SyncResult = { inserted: 0, updated: 0, unchanged: 0 };
  const ids = new Map(existing.map((t) => [t.slug, t.id]));
  for (const def of TAGS) if (!ids.has(def.slug)) ids.set(def.slug, ulid());

  const statements = [];
  for (const [index, def] of TAGS.entries()) {
    const row = {
      slug: def.slug,
      name: def.name,
      facet: def.facet,
      description: def.definition,
      includeWhen: def.include_when ?? null,
      examples: def.examples ?? null,
      parentId: def.parent ? (ids.get(def.parent) ?? null) : null,
      synonyms: [...(def.synonyms ?? [])],
      commonlyExcluded: def.commonly_excluded ?? false,
      status: def.status ?? "active",
      replacedBy: def.replaced_by ?? null,
      sort: index,
    };
    const current = bySlug.get(def.slug);
    if (!current) {
      statements.push(
        db.insert(tags).values({ id: ids.get(def.slug) ?? ulid(), ...row, createdAt: now, updatedAt: now }),
      );
      result.inserted++;
      continue;
    }
    const changed = (Object.keys(row) as (keyof typeof row)[]).some(
      (k) => JSON.stringify(row[k]) !== JSON.stringify(current[k]),
    );
    if (!changed) {
      result.unchanged++;
      continue;
    }
    statements.push(
      db
        .update(tags)
        .set({ ...row, updatedAt: now })
        .where(eq(tags.id, current.id)),
    );
    result.updated++;
  }
  // D1 batches are atomic; keep each well under the per-invocation query limit.
  for (let i = 0; i < statements.length; i += 50) {
    const chunk = statements.slice(i, i + 50);
    if (chunk.length) await db.batch(chunk as [(typeof chunk)[number], ...typeof chunk]);
  }
  return result;
}
