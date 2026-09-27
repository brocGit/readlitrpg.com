#!/usr/bin/env node
// Validates data/taxonomy.yaml, checks it against docs/TAXONOMY.md, and generates
// packages/core/src/taxonomy/taxonomy.gen.ts (DESIGN §6, §6.5).
//
//   node scripts/taxonomy-build.mjs          validate and regenerate
//   node scripts/taxonomy-build.mjs --check  validate and fail if the generated file is stale (CI)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "data", "taxonomy.yaml");
const DOC = join(ROOT, "docs", "TAXONOMY.md");
const OUT = join(ROOT, "packages", "core", "src", "taxonomy", "taxonomy.gen.ts");
const check = process.argv.includes("--check");

const errors = [];
const fail = (msg) => errors.push(msg);

const data = YAML.parse(readFileSync(SOURCE, "utf8"));
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY = /^[a-z]+(_[a-z]+)*$/;
const STATUSES = new Set(["active", "proposed", "retired"]);

// Facets
const facetKeys = new Set();
for (const f of data.facets ?? []) {
  if (!KEY.test(f.key)) fail(`facet key "${f.key}" must be snake_case`);
  if (facetKeys.has(f.key)) fail(`duplicate facet ${f.key}`);
  facetKeys.add(f.key);
  if (typeof f.name !== "string" || typeof f.multi !== "boolean") fail(`facet ${f.key} needs name and multi`);
}

// Tags
const slugs = new Set();
for (const t of data.tags ?? []) {
  const where = `tag ${t.slug}`;
  if (!SLUG.test(t.slug ?? "")) fail(`${where}: slug must be kebab-case`);
  if (slugs.has(t.slug)) fail(`${where}: duplicate slug`);
  slugs.add(t.slug);
  if (!facetKeys.has(t.facet)) fail(`${where}: unknown facet ${t.facet}`);
  for (const field of ["name", "definition"]) {
    if (typeof t[field] !== "string" || !t[field].trim()) fail(`${where}: missing ${field}`);
  }
  if (t.name && t.name.length > 60) fail(`${where}: name longer than 60 characters`);
  t.status ??= "active";
  if (!STATUSES.has(t.status)) fail(`${where}: status must be active, proposed or retired`);
  if (t.synonyms && (!Array.isArray(t.synonyms) || t.synonyms.some((s) => typeof s !== "string"))) {
    fail(`${where}: synonyms must be a list of strings`);
  }
}
for (const t of data.tags ?? []) {
  if (t.status === "retired" && !slugs.has(t.replaced_by ?? "")) fail(`tag ${t.slug}: retired tags need replaced_by`);
  if (t.parent && !slugs.has(t.parent)) fail(`tag ${t.slug}: unknown parent ${t.parent}`);
}

// Dials, stats and the other vocabularies
const dialKeys = (data.dials ?? []).map((d) => d.key);
const statKeys = (data.stats ?? []).map((s) => s.key);
for (const d of data.dials ?? []) {
  if (!KEY.test(d.key)) fail(`dial ${d.key}: key must be snake_case`);
  for (const a of [0, 5, 10]) if (!d.anchors?.[a]) fail(`dial ${d.key}: missing anchor ${a}`);
}
for (const s of data.stats ?? []) {
  if (!KEY.test(s.key)) fail(`stat ${s.key}: key must be snake_case`);
  if (s.type !== "judgment" && s.type !== "descriptive") fail(`stat ${s.key}: type must be judgment or descriptive`);
  for (const a of [0, 5, 10]) if (!s.anchors?.[a]) fail(`stat ${s.key}: missing anchor ${a}`);
}
const sequence = (list, name) => {
  const values = (list ?? []).map((v) => v.value);
  if (values.join(",") !== values.map((_, i) => i).join(",")) fail(`${name} values must be 0..n in order`);
};
sequence(data.crunch_levels, "crunch_levels");
sequence(data.romance_levels, "romance_levels");
for (const f of data.content_flags ?? []) if (!SLUG.test(f.slug)) fail(`content flag ${f.slug}: slug must be kebab-case`);

// Cross-check with docs/TAXONOMY.md: the same slugs and keys in both places.
const doc = readFileSync(DOC, "utf8");
const docSection = (heading) => {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\n##? /);
  return end < 0 ? rest : rest.slice(0, end);
};
const docSlugs = new Set();
for (const heading of [
  "## 1. Genre",
  "## 2. Premise",
  "## 3. Activities",
  "## 4. Protagonist",
  "### 4a. Class",
  "## 5. Progression",
  "## 5a. System flavor",
  "### 7c. Relationship",
  "## 8. Tone",
]) {
  for (const m of docSection(heading).matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) docSlugs.add(m[1]);
}
const yamlActive = new Set((data.tags ?? []).filter((t) => t.status !== "retired").map((t) => t.slug));
for (const s of docSlugs) if (!yamlActive.has(s)) fail(`TAXONOMY.md has tag ${s} but taxonomy.yaml doesn't`);
for (const s of yamlActive) if (!docSlugs.has(s)) fail(`taxonomy.yaml has tag ${s} but TAXONOMY.md doesn't`);
const docKeys = (heading) => new Set([...docSection(heading).matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]));
const same = (a, b) => a.length === b.size && a.every((k) => b.has(k));
if (!same(dialKeys, docKeys("## 12. Taste dials"))) fail("dial keys differ between taxonomy.yaml and TAXONOMY.md §12");
if (!same(statKeys, docKeys("## 13. Book stats"))) fail("stat keys differ between taxonomy.yaml and TAXONOMY.md §13");
const flagSlugs = (data.content_flags ?? []).map((f) => f.slug);
if (!same(flagSlugs, new Set([...docSection("## 9. Content flags").matchAll(/^\| `([a-z-]+)`/gm)].map((m) => m[1])))) {
  fail("content flags differ between taxonomy.yaml and TAXONOMY.md §9");
}

if (errors.length) {
  console.error(`taxonomy.yaml has ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
const body = `// Generated by scripts/taxonomy-build.mjs from data/taxonomy.yaml. Do not edit.
// Run \`pnpm taxonomy\` after changing the YAML.

export const TAXONOMY_HASH = ${JSON.stringify(hash)};

export const TAXONOMY_DATA = ${JSON.stringify(data, null, 2)} as const;
`;

let current = "";
try {
  current = readFileSync(OUT, "utf8");
} catch {}
if (check) {
  if (current !== body) {
    console.error("taxonomy.gen.ts is stale. Run `pnpm taxonomy` and commit the result.");
    process.exit(1);
  }
  console.log(`Taxonomy OK: ${slugs.size} tags, ${dialKeys.length} dials, ${statKeys.length} stats (${hash}).`);
} else {
  if (current !== body) writeFileSync(OUT, body);
  console.log(`Taxonomy built: ${slugs.size} tags, ${dialKeys.length} dials, ${statKeys.length} stats (${hash}).`);
}
