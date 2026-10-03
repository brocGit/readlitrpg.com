// The web Worker's side of matching (DESIGN §7.8, §9.1): load the model, turn inputs into a
// profile, score, and shape the results for pages and islands. Nothing here reads the session, so
// the same inputs always give the same, cacheable answer.

import { hashIp } from "@rlr/core";
import {
  bookCards,
  buildProfile,
  classicPool,
  encodeInputs,
  explain,
  type FeatureMatrix,
  type FunQuizSignal,
  findBooks,
  findQuerySchema,
  getList,
  headsUps,
  loadMatrix,
  type MatchInputs,
  type MatchOptions,
  match,
  matchOptionsFrom,
  nextClassics,
  profileStrength,
  readerClass,
  renderExplanation,
  renderHeadsUp,
  type Scored,
  seriesStatus,
  stat,
  type TasteProfile,
} from "@rlr/core/match";
import {
  getOutcome,
  getQuiz,
  outcomeSignal,
  QuizAnswerError,
  READER_CLASSES,
  takeQuiz,
} from "@rlr/core/quiz";
import type { Settings } from "@rlr/core/settings";
import type { Cover } from "@rlr/core/site";
import { STATS } from "@rlr/core/taxonomy";
import { env, getDb } from "./runtime";

export const matchOptions = (s: Settings): MatchOptions => matchOptionsFrom(s);

export const getMatrix = (): Promise<FeatureMatrix | null> => loadMatrix(env.CONFIG);

export interface ListPreview {
  total: number;
  covers: { title: string; cover: Cover | null }[];
}

/**
 * Each living list's size and first three covers, for the list cards (DESIGN §9.10): the saved
 * searches run against the in-memory model, then one lookup fetches the covers for all of them.
 */
export async function listPreviews(slugs: string[], settings: Settings): Promise<Map<string, ListPreview>> {
  const out = new Map<string, ListPreview>();
  const m = await getMatrix();
  if (!m) return out;
  const tops = new Map<string, string[]>();
  for (const slug of slugs) {
    const list = getList(slug);
    if (!list) continue;
    const { total, hits } = findBooks(m, findQuerySchema.parse(list.query), null, matchOptions(settings));
    tops.set(
      slug,
      hits.slice(0, 3).map((h) => m.ids[h.i] ?? ""),
    );
    out.set(slug, { total, covers: [] });
  }
  const cards = await bookCards(getDb(), [...tops.values()].flat());
  for (const [slug, ids] of tops) {
    const preview = out.get(slug);
    if (!preview) continue;
    preview.covers = ids.flatMap((id) => {
      const c = cards.get(id);
      return c ? [{ title: c.title, cover: c.cover }] : [];
    });
  }
  return out;
}

export function quizSignal(inputs: MatchInputs, s: Settings): FunQuizSignal | null {
  if (!inputs.quiz) return null;
  const quiz = getQuiz(inputs.quiz.slug);
  if (!quiz) return null;
  const scale = s["quiz.fun_effect_importance"];
  try {
    if (inputs.quiz.answers?.length) return takeQuiz(quiz, inputs.quiz.answers, scale).signal;
  } catch (error) {
    if (!(error instanceof QuizAnswerError)) throw error;
  }
  const outcome = inputs.quiz.outcome ? getOutcome(quiz, inputs.quiz.outcome) : undefined;
  return outcome ? outcomeSignal(outcome, scale) : null;
}

// ---------------------------------------------------------------------------------------------
// The book status screen (DESIGN §6.7): descriptive stats may show an estimate; judgment stats
// show ??? until readers have appraised them.

export interface StatusRow {
  key: string;
  name: string;
  value: number | null;
  label: "Readers say" | "Estimated" | "???";
}

const STAT_TYPE = new Map(STATS.map((s) => [s.key, s.type]));
const STAT_NAME = new Map(STATS.map((s) => [s.key, s.name]));

export function statusScreen(m: FeatureMatrix, i: number, keys?: string[]): StatusRow[] {
  return m.stats
    .map((key, s) => ({ key, s }))
    .filter(({ key }) => !keys || keys.includes(key))
    .map(({ key, s }) => {
      const x = stat(m, i, s);
      const judgment = STAT_TYPE.get(key) === "judgment";
      if (!x.public || x.value === null)
        return { key, name: STAT_NAME.get(key) ?? key, value: null, label: "???" as const };
      return {
        key,
        name: STAT_NAME.get(key) ?? key,
        value: Math.round(x.value),
        label: judgment ? ("Readers say" as const) : ("Estimated" as const),
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Results

export interface ResultCard {
  slug: string;
  title: string;
  series: { name: string; position: number | null; status: string } | null;
  authors: string[];
  summary: string | null;
  hook: string | null;
  formats: string[];
  kindleUnlimited: boolean;
  percent: number;
  isMatch: boolean;
  why: string;
  differs: string | null;
  notes: string[];
  headsUps: { key: string; text: string }[];
  status: StatusRow[];
  links: { kind: string; url: string }[];
}

export interface MatchResponse {
  ready: boolean;
  best: ResultCard[];
  more: ResultCard[];
  wildcard: ResultCard | null;
  readerClass: { key: string; name: string; tagline: string } | null;
  strength: number;
  considered: number;
  share: string;
  loved: { slug: string; title: string }[];
}

/** Stats a card shows: the reader's must-haves first, then the most informative known ones. */
function cardStats(m: FeatureMatrix, i: number, p: TasteProfile): StatusRow[] {
  const rows = statusScreen(m, i);
  const musts = Object.keys(p.stats);
  const ordered = [
    ...rows.filter((r) => musts.includes(r.key)),
    ...rows.filter((r) => !musts.includes(r.key) && r.value !== null),
  ];
  return ordered.slice(0, 4);
}

export async function buildCards(
  m: FeatureMatrix,
  p: TasteProfile,
  scored: Scored[],
  opts: MatchOptions,
): Promise<ResultCard[]> {
  const ids = [...scored.map((s) => m.ids[s.i] ?? ""), ...p.loved.map((i) => m.ids[i] ?? "")];
  const cards = await bookCards(getDb(), ids);
  const titleOf = (i: number) => cards.get(m.ids[i] ?? "")?.title;
  const out: ResultCard[] = [];
  for (const s of scored) {
    const card = cards.get(m.ids[s.i] ?? "");
    if (!card) continue; // unpublished since the model was built
    const text = renderExplanation(explain(m, s.i, p), titleOf);
    out.push({
      slug: card.slug,
      title: card.title,
      series: card.series
        ? { name: card.series.name, position: card.series.position, status: seriesStatus(m, s.i) }
        : null,
      authors: card.authors.map((a) => a.name),
      summary: card.summary,
      hook: card.hook,
      formats: card.formats,
      kindleUnlimited: card.kindleUnlimited,
      percent: s.percent,
      isMatch: s.isMatch,
      why: text.why,
      differs: text.differs,
      notes: text.notes,
      headsUps: headsUps(m, s.i, p, opts).map((h) => ({ key: h.key, text: renderHeadsUp(h) })),
      status: cardStats(m, s.i, p),
      links: card.links.slice(0, 4),
    });
  }
  return out;
}

export async function runMatch(inputs: MatchInputs, settings: Settings): Promise<MatchResponse> {
  const m = await getMatrix();
  const share = encodeInputs(inputs);
  if (!m || m.n === 0) {
    return {
      ready: false,
      best: [],
      more: [],
      wildcard: null,
      readerClass: null,
      strength: 0,
      considered: 0,
      share,
      loved: [],
    };
  }
  const opts = matchOptions(settings);
  const profile = buildProfile(m, inputs, quizSignal(inputs, settings));
  const result = match(m, profile, opts);
  const all = await buildCards(
    m,
    profile,
    [...result.bestBets, ...result.more, ...(result.wildcard ? [result.wildcard] : [])],
    opts,
  );
  const bySlug = new Map(all.map((c) => [c.slug, c]));
  const pick = (list: Scored[]) =>
    list.map((s) => bySlug.get(m.slugs[s.i] ?? "")).filter((c): c is ResultCard => Boolean(c));
  const cls = readerClass(profile).cls;
  const lovedCards = await bookCards(
    getDb(),
    profile.loved.map((i) => m.ids[i] ?? ""),
  );
  return {
    ready: true,
    best: pick(result.bestBets),
    more: pick(result.more),
    wildcard: result.wildcard ? (pick([result.wildcard])[0] ?? null) : null,
    readerClass: { key: cls.key, name: cls.name, tagline: cls.tagline },
    strength: profileStrength(profile),
    considered: result.considered,
    share,
    loved: [...lovedCards.values()].map((c) => ({ slug: c.slug, title: c.title })),
  };
}

export async function classicsFor(settings: Settings, rated: string[]) {
  const m = await getMatrix();
  if (!m) return [];
  const index = new Map(m.slugs.map((s, i) => [s, i]));
  const pool = classicPool(m, settings["match.classic_slugs"]);
  const ratedIdx = rated.map((s) => index.get(s)).filter((i): i is number => i !== undefined);
  const next = nextClassics(m, pool, ratedIdx, 4);
  const cards = await bookCards(
    getDb(),
    next.map((i) => m.ids[i] ?? ""),
  );
  return next
    .map((i) => cards.get(m.ids[i] ?? ""))
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => ({
      slug: c.slug,
      title: c.title,
      authors: c.authors.map((a) => a.name).join(", "),
      series: c.series?.name ?? null,
    }));
}

/**
 * The reader class for saved tastes (QUIZZES §2.2). A class-quiz result is the class itself;
 * anything else goes through the match model. Empty tastes have no class yet.
 */
export async function classForInputs(
  inputs: MatchInputs,
  settings: Settings,
): Promise<{ key: string; name: string } | null> {
  const direct = READER_CLASSES.find((c) => c.key === inputs.quiz?.outcome);
  if (direct) return { key: direct.key, name: direct.name };
  if (Object.keys(inputs).length === 0) return null;
  const m = await getMatrix();
  if (!m || m.n === 0) return null;
  const cls = readerClass(buildProfile(m, inputs, quizSignal(inputs, settings))).cls;
  return { key: cls.key, name: cls.name };
}

/** Per-IP limits for the public APIs, keyed by a salted daily hash (no raw IPs; DESIGN §15.9). */
export async function withinLimit(
  limiter: RateLimit | undefined,
  scope: string,
  request: Request,
  ip: string,
): Promise<boolean> {
  if (!limiter) return true;
  const salt = env.IP_HASH_SALT_SEED ?? "local";
  const key = `${scope}:${await hashIp(request.headers.get("cf-connecting-ip") ?? ip, salt)}`;
  const { success } = await limiter.limit({ key });
  return success;
}
