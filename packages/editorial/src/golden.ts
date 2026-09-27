// Building the golden set (DESIGN §7.14): two independent labeling passes are merged; where they
// agree the label stands, and every disagreement goes to a third, adjudicating pass. Nothing here
// needs the owner.

import { type ClassifyProposal, validateProposal } from "@rlr/core/editorial";
import { getTag } from "@rlr/core/taxonomy";
import type { GoldenEntry } from "./eval";

export interface GoldenInput {
  item_id: string;
  input: {
    book: {
      id: string;
      title: string;
      authors: string[];
      series?: { name: string; position: number | null } | null;
    };
  };
}

export interface Conflict {
  id: string;
  title: string;
  /** e.g. "harem", "tag:cozy", "flag:gore", "dial:pacing". */
  field: string;
  a: unknown;
  b: unknown;
}

export interface Resolution {
  id: string;
  field: string;
  /** The adjudicated value: for tags and flags, true (applies) or false. */
  value: unknown;
  reason: string;
}

const WEIGHT = { high: 2, medium: 1, low: 0.5 } as const;

/** Merge two passes. Returns entries with every agreed label, and the disagreements. */
export function mergePasses(inputs: GoldenInput[], passA: unknown[], passB: unknown[]) {
  const parse = (raws: unknown[], name: string) => {
    const out = new Map<string, ClassifyProposal>();
    for (const raw of raws) {
      const v = validateProposal(raw);
      if (!v.ok)
        throw new Error(
          `${name}: invalid proposal for ${(raw as { book_id?: string }).book_id}: ${v.errors[0]}`,
        );
      if (v.proposal.kind === "classify") out.set(v.proposal.book_id, v.proposal);
    }
    return out;
  };
  const a = parse(passA, "pass A");
  const b = parse(passB, "pass B");
  const conflicts: Conflict[] = [];
  const entries: (GoldenEntry & { pending: string[] })[] = [];

  for (const item of inputs) {
    const book = item.input.book;
    const pa = a.get(book.id);
    const pb = b.get(book.id);
    if (!pa || !pb) throw new Error(`${book.id} is missing from pass ${pa ? "B" : "A"}`);
    const pending: string[] = [];
    const conflict = (field: string, va: unknown, vb: unknown) => {
      conflicts.push({ id: book.id, title: book.title, field, a: va, b: vb });
      pending.push(field);
    };
    const same = <T>(field: string, va: T, vb: T): T | undefined => {
      if (va === vb && va !== "unknown") return va;
      conflict(field, va, vb);
      return undefined;
    };

    const inScope = same("in_scope", pa.in_scope, pb.in_scope);
    const genre = same("primary_genre", pa.primary_genre, pb.primary_genre);
    const harem = same("harem", pa.harem.value, pb.harem.value);
    const crunch = same("crunch_level", pa.crunch_level.value, pb.crunch_level.value);
    const romance = same("romance_level", pa.romance_level.value, pb.romance_level.value);

    const tags: string[] = [];
    const evidence: Record<string, string> = {};
    const weightOf = (p: ClassifyProposal, slug: string) => {
      const t = p.tags.find((x) => x.slug === slug);
      return t ? WEIGHT[t.confidence] : 0;
    };
    for (const slug of new Set([...pa.tags, ...pb.tags].map((t) => t.slug))) {
      const wa = weightOf(pa, slug);
      const wb = weightOf(pb, slug);
      const excludable = Boolean(getTag(slug)?.commonly_excluded);
      const agreeYes = (wa >= 1 && wb >= 1) || (wa + wb >= 2.5 && !excludable);
      const agreeNo = wa < 1 && wb < 1 && !excludable;
      if (agreeYes) {
        tags.push(slug);
        evidence[`tag:${slug}`] =
          pa.tags.find((t) => t.slug === slug)?.evidence ??
          pb.tags.find((t) => t.slug === slug)?.evidence ??
          "";
      } else if (!agreeNo) {
        // Exclusion tags never drop silently: any mention either way is adjudicated.
        conflict(`tag:${slug}`, wa, wb);
      }
    }

    const flags: string[] = [];
    for (const flag of new Set([...pa.content_flags, ...pb.content_flags])) {
      if (pa.content_flags.includes(flag) && pb.content_flags.includes(flag)) flags.push(flag);
      else conflict(`flag:${flag}`, pa.content_flags.includes(flag), pb.content_flags.includes(flag));
    }

    const dials: Record<string, number> = {};
    for (const key of new Set([...Object.keys(pa.dials), ...Object.keys(pb.dials)])) {
      const va = pa.dials[key]?.value;
      const vb = pb.dials[key]?.value;
      const na = typeof va === "number" ? va : null;
      const nb = typeof vb === "number" ? vb : null;
      if (na !== null && nb !== null) {
        if (Math.abs(na - nb) <= 2) dials[key] = Math.round((na + nb) / 2);
        else conflict(`dial:${key}`, na, nb);
      } else if (na !== null || nb !== null) {
        dials[key] = (na ?? nb) as number;
      }
    }

    entries.push({
      id: book.id,
      book: { title: book.title, authors: book.authors, series: book.series ?? null },
      labels: {
        in_scope: inScope ?? "yes",
        primary_genre: genre ?? pa.primary_genre,
        tags: tags.sort(),
        crunch_level: typeof crunch === "number" ? crunch : 0,
        romance_level: typeof romance === "number" ? romance : 0,
        harem: harem && harem !== "unknown" ? harem : "none",
        content_flags: flags.sort(),
        dials,
      },
      evidence,
      pending,
    });
  }
  return { entries, conflicts };
}

/** Apply adjudicated answers. Returns finished entries and any conflict still unanswered. */
export function applyResolutions(
  merged: ReturnType<typeof mergePasses>,
  resolutions: Resolution[],
): { golden: GoldenEntry[]; open: Conflict[] } {
  const byKey = new Map(resolutions.map((r) => [`${r.id}|${r.field}`, r]));
  const open = merged.conflicts.filter((c) => !byKey.has(`${c.id}|${c.field}`));
  const golden = merged.entries.map(({ pending, ...entry }) => {
    const e: GoldenEntry = structuredClone(entry);
    for (const field of pending) {
      const r = byKey.get(`${e.id}|${field}`);
      if (!r) continue;
      const [kind, key = ""] = field.split(":");
      if (kind === "tag" && r.value === true && !e.labels.tags.includes(key)) e.labels.tags.push(key);
      else if (kind === "flag" && r.value === true && !e.labels.content_flags.includes(key))
        e.labels.content_flags.push(key);
      else if (kind === "dial" && typeof r.value === "number") e.labels.dials[key] = r.value;
      else if (kind === "in_scope") e.labels.in_scope = r.value as GoldenEntry["labels"]["in_scope"];
      else if (kind === "primary_genre") e.labels.primary_genre = String(r.value);
      else if (kind === "harem") e.labels.harem = r.value as GoldenEntry["labels"]["harem"];
      else if (kind === "crunch_level") e.labels.crunch_level = Number(r.value);
      else if (kind === "romance_level") e.labels.romance_level = Number(r.value);
      e.evidence = { ...e.evidence, [field]: `adjudicated: ${r.reason}` };
    }
    e.labels.tags.sort();
    e.labels.content_flags.sort();
    return e;
  });
  return { golden, open };
}
