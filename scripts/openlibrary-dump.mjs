#!/usr/bin/env node
// Extracts LitRPG-relevant works from the Open Library bulk dumps (DESIGN §7.15 source 2) into an
// NDJSON file the admin console imports ("Open Library extract"). Each row carries an Open Library
// confirmation, so a seed it matches passes the publication gate.
//
//   node scripts/openlibrary-dump.mjs \
//     --works ol_dump_works_latest.txt.gz --authors ol_dump_authors_latest.txt.gz \
//     --out data/imports/openlibrary-litrpg.ndjson
//
// Dumps: https://openlibrary.org/developers/dumps (tab-separated: type, key, revision,
// last_modified, JSON). The works dump is several GB; both passes stream it, so memory stays small.

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

/** Subjects that put a work in scope, and what they map to. First genre match wins. */
export const GENRE_SUBJECTS = [
  [/\blit\s*-?\s*rpg\b/i, "litrpg"],
  [/\bgame\s*-?\s*lit\b/i, "gamelit"],
  [/\bcultivation\b|\bxianxia\b|\bwuxia\b/i, "cultivation"],
  [/\bprogression fantasy\b/i, "progression-fantasy"],
];
export const TAG_SUBJECTS = [
  [/\bdungeon cores?\b/i, "dungeon-core"],
  [/\bsystem apocalypse\b/i, "system-apocalypse"],
  [/\bvrmmo(rpg)?\b|\bvirtual reality\b/i, "vrmmo"],
  [/\bisekai\b|\bportal fantasy\b/i, "isekai"],
  [/\bdungeon crawl/i, "dungeon-crawler"],
  [/\bkingdom build/i, "kingdom-building"],
  [/\btime loops?\b/i, "time-loop"],
  [/\bharem\b/i, null], // noted but never auto-tagged: harem is resolved conservatively elsewhere
];

/** Pure: the import row for one work, or null when it's out of scope. */
export function workToRow(work, authorNames) {
  const subjects = Array.isArray(work.subjects) ? work.subjects.filter((s) => typeof s === "string") : [];
  let genre = null;
  for (const [pattern, slug] of GENRE_SUBJECTS) {
    if (subjects.some((s) => pattern.test(s))) {
      genre = slug;
      break;
    }
  }
  if (!genre || typeof work.title !== "string" || !work.title.trim()) return null;
  const authors = authorNames.filter(Boolean).slice(0, 5);
  if (authors.length === 0) return null;
  const tags = new Set();
  for (const [pattern, slug] of TAG_SUBJECTS) {
    if (slug && subjects.some((s) => pattern.test(s))) tags.add(slug);
  }
  const year = /\b(19[5-9]\d|20\d\d)\b/.exec(String(work.first_publish_date ?? ""))?.[1];
  return {
    input: {
      title: work.title.trim().slice(0, 300),
      authors: authors.map((name) => ({ name: String(name).trim().slice(0, 200) })),
      primaryGenre: genre,
      ...(tags.size ? { tags: [...tags].map((slug) => ({ slug, confidence: 0.6 })) } : {}),
      ...(year ? { firstPublished: year } : {}),
    },
    confirmation: { source: "openlibrary", ref: String(work.key ?? "") },
  };
}

export function authorKeys(work) {
  return (Array.isArray(work.authors) ? work.authors : [])
    .map((a) => a?.author?.key ?? a?.key)
    .filter((k) => typeof k === "string");
}

async function* dumpRecords(path, type) {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const parts = line.split("\t");
    if (parts[0] !== type || !parts[4]) continue;
    try {
      yield JSON.parse(parts[4]);
    } catch {
      // A malformed line in a multi-GB dump isn't worth stopping for.
    }
  }
}

export async function extract({ works, authors, out }) {
  const keep = [];
  const needed = new Set();
  let scanned = 0;
  for await (const work of dumpRecords(works, "/type/work")) {
    scanned++;
    const subjects = Array.isArray(work.subjects) ? work.subjects : [];
    if (!subjects.some((s) => typeof s === "string" && GENRE_SUBJECTS.some(([p]) => p.test(s)))) continue;
    keep.push(work);
    for (const k of authorKeys(work)) needed.add(k);
  }
  const names = new Map();
  for await (const author of dumpRecords(authors, "/type/author")) {
    if (needed.has(author.key) && typeof author.name === "string") names.set(author.key, author.name);
  }
  const output = createWriteStream(out);
  let written = 0;
  for (const work of keep) {
    const row = workToRow(work, authorKeys(work).map((k) => names.get(k)));
    if (!row) continue;
    output.write(`${JSON.stringify(row)}\n`);
    written++;
  }
  await new Promise((resolve) => output.end(resolve));
  return { scanned, matched: keep.length, written };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const works = arg("works");
  const authors = arg("authors");
  const out = arg("out") ?? "openlibrary-litrpg.ndjson";
  if (!works || !authors) {
    console.error("usage: node scripts/openlibrary-dump.mjs --works <works.txt.gz> --authors <authors.txt.gz> [--out file]");
    process.exit(2);
  }
  const result = await extract({ works, authors, out });
  console.log(`Scanned ${result.scanned} works, ${result.matched} in scope, wrote ${result.written} rows to ${out}.`);
}
