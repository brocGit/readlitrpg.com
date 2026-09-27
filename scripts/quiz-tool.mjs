#!/usr/bin/env node
// Validates, balance-tests and renders the quiz drafts in data/quizzes/.
// Two kinds: personality quizzes ("fun": points pick a result) and trivia ("trivia": score picks a tier).
//
//   node scripts/quiz-tool.mjs check          validate every quiz and run the balance simulation
//   node scripts/quiz-tool.mjs render         check, then write readable previews to docs/quizzes/
//   node scripts/quiz-tool.mjs build          check, then generate packages/core/src/quiz/quizzes.gen.ts
//   node scripts/quiz-tool.mjs build --check  fail if the generated module is out of date (CI)
//
// No dependencies. The rules match DESIGN.md §7.16, so the quiz factory can reuse this logic.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUIZ_DIR = join(ROOT, "data", "quizzes");
const PREVIEW_DIR = join(ROOT, "docs", "quizzes");
const GENERATED = join(ROOT, "packages", "core", "src", "quiz", "quizzes.gen.ts");
const SIMULATION_RUNS = 10_000;

// DESIGN.md §6.6 and §6.7.
const DIALS = [
  "pacing", "tone", "humor", "crunch", "progression_speed", "power_fantasy", "rigour", "combat", "scope",
  "ensemble", "lore", "morality", "strategy", "prose", "danger", "plot_structure", "romance",
];
const STATS = [
  "competent_mc", "rule_of_cool", "number_go_up", "build_payoff", "earned_power", "system_consistency",
  "hype", "low_drama", "party_chemistry", "rootable_mc", "fast_start", "satisfying_endings",
];
const TAGS = loadTagSlugs();

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

// Tag slugs come from the facet sections of TAXONOMY.md: table rows whose first cell is a
// backticked slug, plus the dot-separated slug lines in §4a and §7c.
function loadTagSlugs() {
  const text = readFileSync(join(ROOT, "docs", "TAXONOMY.md"), "utf8");
  const tagSections = new Set(["1", "2", "3", "4", "4a", "5", "5a", "7c", "8", "9"]);
  const slugs = new Set();
  let section = null;
  for (const line of text.split("\n")) {
    const heading = line.match(/^#{2,3} (\d+[a-z]?)\. /);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!tagSections.has(section)) continue;
    const row = line.match(/^\| `([a-z0-9-]+)` \|/);
    if (row) slugs.add(row[1]);
    else if (line.startsWith("`") && (section === "4a" || section === "7c")) {
      for (const m of line.matchAll(/`([a-z0-9-]+)`/g)) slugs.add(m[1]);
    }
  }
  return slugs;
}

function loadQuizzes() {
  const classes = JSON.parse(readFileSync(join(QUIZ_DIR, "reader-classes.json"), "utf8")).classes;
  const quizzes = readdirSync(QUIZ_DIR)
    .filter((f) => f.endsWith(".json") && f !== "reader-classes.json")
    .sort()
    .map((file) => {
      const quiz = JSON.parse(readFileSync(join(QUIZ_DIR, file), "utf8"));
      quiz.file = file;
      quiz.outcomes = quiz.outcomes_from === "reader-classes" ? classes : quiz.outcomes;
      return quiz;
    });
  return { classes, quizzes };
}

function checkRange(where, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(where, `expected an integer ${min}..${max}, got ${value}`);
}

function validateEffects(where, effects = {}) {
  for (const [k, v] of Object.entries(effects.dials ?? {})) {
    if (!DIALS.includes(k)) fail(where, `unknown dial "${k}"`);
    checkRange(`${where} dial ${k}`, v, -2, 2);
  }
  for (const [k, v] of Object.entries(effects.stats ?? {})) {
    if (!STATS.includes(k)) fail(where, `unknown stat "${k}"`);
    checkRange(`${where} stat ${k}`, v, 1, 2);
  }
  for (const [k, v] of Object.entries(effects.tags ?? {})) {
    if (!TAGS.has(k)) fail(where, `unknown tag "${k}"`);
    checkRange(`${where} tag ${k}`, v, -1, 3);
  }
  const count = ["dials", "stats", "tags"].reduce((n, key) => n + Object.keys(effects[key] ?? {}).length, 0);
  if (count === 0) fail(where, "every option needs at least one taste effect");
}

function validateSeed(where, seed) {
  if (!seed) return fail(where, "missing profile_seed");
  for (const [k, v] of Object.entries(seed.dials ?? {})) {
    if (!DIALS.includes(k)) fail(where, `unknown dial "${k}"`);
    checkRange(`${where} dial ${k} target`, v.target, 0, 10);
    if (!(v.importance > 0 && v.importance <= 1)) fail(where, `dial ${k} importance must be in (0, 1]`);
  }
  for (const [k, v] of Object.entries(seed.stats ?? {})) {
    if (!STATS.includes(k)) fail(where, `unknown stat "${k}"`);
    checkRange(`${where} stat ${k} floor`, v, 0, 10);
  }
  for (const k of Object.keys(seed.tags ?? {})) if (!TAGS.has(k)) fail(where, `unknown tag "${k}"`);
}

function validateQuiz(quiz) {
  const at = quiz.file;
  for (const field of ["slug", "title", "dek", "kind", "status", "questions", "outcomes"]) {
    if (!quiz[field]) fail(at, `missing "${field}"`);
  }
  checkSeriesFields(quiz);
  const outcomeKeys = new Set();
  for (const o of quiz.outcomes ?? []) {
    if (outcomeKeys.has(o.key)) fail(at, `duplicate outcome "${o.key}"`);
    outcomeKeys.add(o.key);
    for (const field of ["name", "tagline", "description", "share_text"]) if (!o[field]) fail(`${at} outcome ${o.key}`, `missing "${field}"`);
    validateSeed(`${at} outcome ${o.key}`, o.profile_seed);
  }
  const primaries = Object.fromEntries([...outcomeKeys].map((k) => [k, 0]));
  const questionIds = new Set();
  for (const q of quiz.questions ?? []) {
    const qa = `${at} ${q.id}`;
    if (questionIds.has(q.id)) fail(at, `duplicate question id "${q.id}"`);
    questionIds.add(q.id);
    if (!q.prompt) fail(qa, "missing prompt");
    if (!(q.options?.length >= 3 && q.options.length <= 6)) fail(qa, "needs 3-6 options");
    const optionIds = new Set();
    for (const opt of q.options ?? []) {
      const oa = `${qa}${opt.id}`;
      if (optionIds.has(opt.id)) fail(qa, `duplicate option id "${opt.id}"`);
      optionIds.add(opt.id);
      if (!opt.label) fail(oa, "missing label");
      if (opt.label && opt.label.length > 90) fail(oa, `label is ${opt.label.length} chars; keep it under 90`);
      const pts = Object.entries(opt.points ?? {});
      if (pts.length === 0) fail(oa, "no personality points");
      for (const [k, v] of pts) {
        if (!outcomeKeys.has(k)) fail(oa, `points for unknown outcome "${k}"`);
        checkRange(`${oa} points ${k}`, v, 1, 3);
      }
      const top = topOutcome(opt);
      if (top) primaries[top] = (primaries[top] ?? 0) + 1;
      validateEffects(oa, opt.effects);
    }
  }
  const minPrimary = Math.min(3, (quiz.questions ?? []).length);
  for (const [k, n] of Object.entries(primaries)) {
    if (n < minPrimary) fail(at, `outcome "${k}" is the top pick of only ${n} options; needs at least ${minPrimary}`);
  }
}

// Series fan quizzes must state their spoiler boundary, carry the unofficial-fan-quiz
// disclaimer, and cite the research behind them (QUIZZES.md §6.1).
function checkSeriesFields(quiz) {
  if (!quiz.series) return;
  if (!quiz.spoiler_boundary) fail(quiz.file, "series quizzes need a spoiler_boundary");
  if (!/unofficial fan quiz/i.test(quiz.disclaimer ?? "")) fail(quiz.file, "series quizzes need the unofficial fan quiz disclaimer");
  if (!(quiz.sources?.length > 0)) fail(quiz.file, "series quizzes need research sources");
}

// The outcome an option favors most (its "primary").
function topOutcome(opt) {
  let best = null;
  for (const [k, v] of Object.entries(opt.points ?? {})) if (!best || v > opt.points[best]) best = k;
  return best;
}

// Scores a set of chosen options. Ties break on (1) how many chosen options had that outcome
// as their primary, then (2) the latest question whose chosen primary is among the tied
// outcomes (the last question is the "soul" question), then (3) outcome order.
function scoreQuiz(quiz, chosen) {
  const totals = new Map(quiz.outcomes.map((o) => [o.key, { points: 0, primaries: 0 }]));
  for (const opt of chosen) {
    for (const [k, v] of Object.entries(opt.points)) totals.get(k).points += v;
    totals.get(topOutcome(opt)).primaries += 1;
  }
  let tied = [...totals.keys()];
  const best = (field) => Math.max(...tied.map((k) => totals.get(k)[field]));
  tied = tied.filter((k) => totals.get(k).points === best("points"));
  tied = tied.filter((k) => totals.get(k).primaries === best("primaries"));
  if (tied.length > 1) {
    for (let i = chosen.length - 1; i >= 0; i--) {
      const p = topOutcome(chosen[i]);
      if (tied.includes(p)) return p;
    }
  }
  return tied[0];
}

// Every outcome must be reachable by a natural answer path: always pick the option that
// favors that outcome the most relative to the others.
function checkReachability(quiz) {
  for (const o of quiz.outcomes) {
    const chosen = quiz.questions.map((q) =>
      q.options.reduce((best, opt) => (margin(opt, o.key) > margin(best, o.key) ? opt : best)),
    );
    const winner = scoreQuiz(quiz, chosen);
    if (winner !== o.key) fail(quiz.file, `outcome "${o.key}" is not reachable by its most favorable answers (got "${winner}")`);
  }
}

function margin(opt, key) {
  const mine = opt.points[key] ?? 0;
  const others = Math.max(0, ...Object.entries(opt.points).filter(([k]) => k !== key).map(([, v]) => v));
  return mine - others * 0.5;
}

// Deterministic PRNG so simulation results are reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Balance thresholds from DESIGN.md Appendix C: max 25% / min 3% for 8 outcomes,
// scaled by outcome count (2x and 0.24x a uniform share).
function simulate(quiz) {
  const rand = mulberry32(20260926);
  const counts = Object.fromEntries(quiz.outcomes.map((o) => [o.key, 0]));
  for (let i = 0; i < SIMULATION_RUNS; i++) {
    const chosen = quiz.questions.map((q) => q.options[Math.floor(rand() * q.options.length)]);
    counts[scoreQuiz(quiz, chosen)] += 1;
  }
  const n = quiz.outcomes.length;
  const max = 2 / n;
  const min = 0.24 / n;
  const shares = Object.entries(counts).map(([k, c]) => [k, c / SIMULATION_RUNS]);
  for (const [k, share] of shares) {
    if (share > max) fail(quiz.file, `outcome "${k}" wins ${(share * 100).toFixed(1)}% of random runs (max ${(max * 100).toFixed(1)}%)`);
    if (share < min) fail(quiz.file, `outcome "${k}" wins ${(share * 100).toFixed(1)}% of random runs (min ${(min * 100).toFixed(1)}%)`);
  }
  return { shares, max, min };
}

function fmtEffects(effects = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(effects.dials ?? {})) parts.push(`${k} ${v > 0 ? "↑".repeat(v) : "↓".repeat(-v)}`);
  for (const [k, v] of Object.entries(effects.stats ?? {})) parts.push(`${k} must-have${v > 1 ? "+" : ""}`);
  for (const [k, v] of Object.entries(effects.tags ?? {})) parts.push(`#${k}${v < 0 ? " ✗" : ""}`);
  return parts.join(", ");
}

function renderPreview(quiz, sim) {
  const name = (key) => quiz.outcomes.find((o) => o.key === key)?.name ?? key;
  const lines = [
    `# ${quiz.title}`,
    "",
    `> Generated by \`scripts/quiz-tool.mjs\` from \`data/quizzes/${quiz.file}\`. Edit the JSON, not this file.`,
    "",
    `*${quiz.dek}*`,
    "",
    `Status: **${quiz.status}** · ${quiz.questions.length} questions · ${quiz.outcomes.length} outcomes · about ${quiz.estimated_seconds} seconds`,
    "",
    ...(quiz.series
      ? [`**Series:** *${quiz.series}* · **Spoiler boundary:** ${quiz.spoiler_boundary}`, "", `> ${quiz.disclaimer}`, ""]
      : []),
    ...(quiz.intro ? [quiz.intro, ""] : []),
    "## Questions",
    "",
    "Each answer shows the outcomes it scores for (★ = 2 points, ☆ = 1 point) and the hidden taste signal it adds to the reader's profile (DESIGN.md §9.3).",
    "",
  ];
  for (const [i, q] of quiz.questions.entries()) {
    lines.push(`### ${i + 1}. ${q.flavor ? `\`${q.flavor}\` ` : ""}${q.prompt}`, "");
    lines.push("| | Answer | Scores | Taste signal |", "|---|---|---|---|");
    for (const opt of q.options) {
      const pts = Object.entries(opt.points)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v >= 2 ? "★" : "☆"} ${name(k)}`)
        .join("<br>");
      lines.push(`| ${opt.id} | ${opt.label.replace(/\|/g, "\\|")} | ${pts} | ${fmtEffects(opt.effects)} |`);
    }
    lines.push("");
  }
  lines.push("## Results", "");
  for (const o of quiz.outcomes) {
    lines.push(`### ${o.name}`, "", `**${o.tagline}**`, "", o.description, "");
    if (o.loves?.length) lines.push(`- **You'll love:** ${o.loves.join(" · ")}`);
    if (o.watch_out) lines.push(`- **Watch out for:** ${o.watch_out}`);
    const seed = o.profile_seed ?? {};
    const dials = Object.entries(seed.dials ?? {}).map(([k, v]) => `${k} → ${v.target}`).join(", ");
    const stats = Object.entries(seed.stats ?? {}).map(([k, v]) => `${k} ≥ ${v}`).join(", ");
    const tags = Object.keys(seed.tags ?? {}).map((t) => `#${t}`).join(" ");
    lines.push(`- **Starting profile:** ${[dials, stats, tags].filter(Boolean).join(" · ")}`);
    if (o.calibration_books?.length) lines.push(`- **Calibration books (define the class; never shown to readers as-is):** ${o.calibration_books.join("; ")}`);
    lines.push(`- **Share text:** "${o.share_text}"`, "");
  }
  lines.push(
    "## Balance check",
    "",
    `${SIMULATION_RUNS.toLocaleString("en-US")} simulated readers answering at random. Allowed range per outcome: ${(sim.min * 100).toFixed(1)}%–${(sim.max * 100).toFixed(1)}%.`,
    "",
    "| Outcome | Share |",
    "|---|---|",
    ...sim.shares.map(([k, s]) => `| ${name(k)} | ${(s * 100).toFixed(1)}% |`),
    "",
  );
  if (quiz.sources?.length) lines.push("## Research sources", "", ...quiz.sources.map((u) => `- ${u}`), "");
  return lines.join("\n");
}


// Trivia quizzes: every question has exactly one correct answer, and the score picks a tier.
function validateTrivia(quiz) {
  const at = quiz.file;
  for (const field of ["slug", "title", "dek", "status", "questions", "outcomes"]) {
    if (!quiz[field]) fail(at, `missing "${field}"`);
  }
  const n = quiz.questions?.length ?? 0;
  const mins = [];
  for (const o of quiz.outcomes ?? []) {
    for (const field of ["key", "name", "tagline", "description", "share_text"]) if (!o[field]) fail(`${at} tier ${o.key}`, `missing "${field}"`);
    checkRange(`${at} tier ${o.key} min_score`, o.min_score, 0, n);
    mins.push(o.min_score);
    if (o.profile_seed) validateSeed(`${at} tier ${o.key}`, o.profile_seed);
  }
  if (mins[0] !== 0) fail(at, "the first tier must start at min_score 0");
  for (let i = 1; i < mins.length; i++) if (!(mins[i] > mins[i - 1])) fail(at, "tier min_scores must strictly increase");
  const ids = new Set();
  for (const q of quiz.questions ?? []) {
    const qa = `${at} ${q.id}`;
    if (ids.has(q.id)) fail(at, `duplicate question id "${q.id}"`);
    ids.add(q.id);
    if (!q.prompt) fail(qa, "missing prompt");
    if (!q.explain) fail(qa, "trivia questions need an \"explain\" line shown after answering");
    if (!(q.options?.length >= 3 && q.options.length <= 5)) fail(qa, "needs 3-5 options");
    const correct = (q.options ?? []).filter((o) => o.correct === true).length;
    if (correct !== 1) fail(qa, `needs exactly one correct answer, found ${correct}`);
    for (const opt of q.options ?? []) {
      if (!opt.label) fail(`${qa}${opt.id}`, "missing label");
      if (opt.label && opt.label.length > 90) fail(`${qa}${opt.id}`, `label is ${opt.label.length} chars; keep it under 90`);
      if (opt.effects) validateEffects(`${qa}${opt.id}`, opt.effects);
    }
  }
}

function triviaTier(quiz, score) {
  return [...quiz.outcomes].reverse().find((o) => score >= o.min_score).key;
}

// Informational: how random guessers spread across tiers (a good trivia quiz rarely hands
// the top tier to someone guessing).
function simulateTrivia(quiz) {
  const rand = mulberry32(20260926);
  const counts = Object.fromEntries(quiz.outcomes.map((o) => [o.key, 0]));
  for (let i = 0; i < SIMULATION_RUNS; i++) {
    const score = quiz.questions.filter((q) => q.options[Math.floor(rand() * q.options.length)].correct).length;
    counts[triviaTier(quiz, score)] += 1;
  }
  const shares = Object.entries(counts).map(([k, c]) => [k, c / SIMULATION_RUNS]);
  const top = shares[shares.length - 1];
  if (top[1] > 0.01) fail(quiz.file, `random guessers reach the top tier ${(top[1] * 100).toFixed(1)}% of the time (max 1%)`);
  return { shares };
}

function renderTriviaPreview(quiz, sim) {
  const name = (key) => quiz.outcomes.find((o) => o.key === key)?.name ?? key;
  const lines = [
    `# ${quiz.title}`,
    "",
    `> Generated by \`scripts/quiz-tool.mjs\` from \`data/quizzes/${quiz.file}\`. Edit the JSON, not this file.`,
    "",
    `*${quiz.dek}*`,
    "",
    `Status: **${quiz.status}** · trivia · ${quiz.questions.length} questions · ${quiz.outcomes.length} tiers · about ${quiz.estimated_seconds} seconds`,
    "",
    "## Questions",
    "",
  ];
  for (const [i, q] of quiz.questions.entries()) {
    lines.push(`### ${i + 1}. ${q.flavor ? `\`${q.flavor}\` ` : ""}${q.prompt}`, "");
    for (const opt of q.options) lines.push(`- ${opt.correct ? "✅ **" + opt.label + "**" : opt.label}`);
    lines.push("", `*After answering:* ${q.explain}`, "");
  }
  lines.push("## Tiers", "");
  for (const o of quiz.outcomes) {
    lines.push(`### ${o.name} (${o.min_score}+ correct)`, "", `**${o.tagline}**`, "", o.description, "", `- **Share text:** "${o.share_text}"`, "");
  }
  lines.push(
    "## Guessing check",
    "",
    `${SIMULATION_RUNS.toLocaleString("en-US")} simulated readers guessing at random. The top tier must stay under 1%.`,
    "",
    "| Tier | Share |",
    "|---|---|",
    ...sim.shares.map(([k, s]) => `| ${name(k)} | ${(s * 100).toFixed(1)}% |`),
    "",
  );
  return lines.join("\n");
}

function main() {
  const command = process.argv[2] ?? "check";
  if (!["check", "render", "build"].includes(command)) {
    console.error("usage: node scripts/quiz-tool.mjs [check|render|build [--check]]");
    process.exit(2);
  }
  const { classes, quizzes } = loadQuizzes();
  const results = [];
  for (const quiz of quizzes) {
    const before = errors.length;
    const trivia = quiz.kind === "trivia";
    if (trivia) validateTrivia(quiz);
    else validateQuiz(quiz);
    if (errors.length > before) continue; // don't simulate a malformed quiz
    if (!trivia) checkReachability(quiz);
    const sim = trivia ? simulateTrivia(quiz) : simulate(quiz);
    results.push({ quiz, sim });
    console.log(`\n${quiz.title} (${quiz.file})`);
    for (const [k, s] of sim.shares) console.log(`  ${k.padEnd(22)} ${(s * 100).toFixed(1).padStart(5)}%`);
  }
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (command === "render") {
    mkdirSync(PREVIEW_DIR, { recursive: true });
    for (const { quiz, sim } of results) {
      const md = quiz.kind === "trivia" ? renderTriviaPreview(quiz, sim) : renderPreview(quiz, sim);
      writeFileSync(join(PREVIEW_DIR, `${quiz.slug}.md`), md);
    }
    console.log(`\nWrote ${results.length} preview(s) to docs/quizzes/.`);
  }
  if (command === "build") build(classes, quizzes, process.argv.includes("--check"));
  console.log(`\nAll ${quizzes.length} quiz(zes) passed.`);
}

// The web and jobs Workers read quizzes from a generated module, so quiz content ships with the
// code that plays it (git is the source of truth; the console decides which quizzes are live).
function build(classes, quizzes, checkOnly) {
  const data = {
    classes,
    quizzes: quizzes.map(({ file, outcomes, ...quiz }) => (quiz.outcomes_from ? quiz : { ...quiz, outcomes })),
  };
  const json = JSON.stringify(data, null, 2);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  const text = `// Generated by scripts/quiz-tool.mjs from data/quizzes/. Do not edit by hand: run \`pnpm quiz build\`.
export const QUIZ_HASH = "${hash}";
export const QUIZ_DATA = ${json} as const;
`;
  if (checkOnly) {
    const current = existsSync(GENERATED) ? readFileSync(GENERATED, "utf8") : "";
    if (current !== text) {
      console.error("\npackages/core/src/quiz/quizzes.gen.ts is out of date: run pnpm quiz build");
      process.exit(1);
    }
    console.log(`\nGenerated quiz module is current (${hash}).`);
    return;
  }
  mkdirSync(dirname(GENERATED), { recursive: true });
  writeFileSync(GENERATED, text);
  console.log(`\nWrote packages/core/src/quiz/quizzes.gen.ts (${hash}).`);
}

main();
