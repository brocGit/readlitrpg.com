// Reader profile helpers shared by the subscription, onboarding and account routes (DESIGN §9.7).

import type { Db } from "@rlr/core/db";
import type { MatchInputs } from "@rlr/core/match";
import { READER_CLASSES } from "@rlr/core/quiz";
import { getReaderProfile, LEVEL_TITLES, type ReaderProfile, saveReaderProfile } from "@rlr/core/readers";
import type { Settings } from "@rlr/core/settings";
import { classForInputs } from "./match";

/**
 * Seed a profile from what the reader did on the way in (a quiz result, a match). Stated tastes are
 * never overwritten by a signup: a quiz result only fills an empty quiz slot, and match inputs only
 * an empty profile.
 */
export async function adoptInputs(
  db: Db,
  userId: string,
  inputs: MatchInputs | null,
  source: string,
  settings: Settings,
): Promise<ReaderProfile> {
  const current = await getReaderProfile(db, userId);
  let patch: Partial<MatchInputs> = {};
  if (inputs?.quiz && !current.inputs.quiz) patch = { quiz: inputs.quiz };
  else if (inputs && Object.keys(current.inputs).length === 0) patch = inputs;
  if (Object.keys(patch).length === 0) return saveReaderProfile(db, userId, {}, { source });
  const merged = { ...current.inputs, ...patch };
  const cls = await classForInputs(merged, settings);
  return saveReaderProfile(db, userId, patch, { source, readerClass: cls?.key ?? current.readerClass });
}

/** Save tastes the reader edited themselves, and recompute their class. */
export async function saveTastes(
  db: Db,
  userId: string,
  inputs: MatchInputs,
  settings: Settings,
  opts: { replace?: boolean; onboarded?: boolean } = {},
): Promise<ReaderProfile & { previousLevel: number }> {
  const current = await getReaderProfile(db, userId);
  const merged = opts.replace ? inputs : { ...current.inputs, ...inputs };
  const cls = await classForInputs(merged, settings);
  // Replacing: name every key, so ones the reader cleared are dropped.
  const patch = opts.replace
    ? (Object.fromEntries(
        Object.keys({ ...current.inputs, ...inputs }).map((k) => [k, (inputs as Record<string, unknown>)[k]]),
      ) as Partial<MatchInputs>)
    : inputs;
  const cleared = opts.replace && Object.keys(inputs).length === 0;
  return saveReaderProfile(db, userId, patch, {
    source: "account",
    // Without a match model to place them, keep the class they had (unless they cleared everything).
    readerClass: cls ? cls.key : cleared ? null : current.readerClass,
    onboarded: opts.onboarded,
  });
}

export function classInfo(key: string | null) {
  const c = READER_CLASSES.find((x) => x.key === key);
  return c ? { key: c.key, name: c.name, tagline: c.tagline } : null;
}

/** QUIZZES §4.2: how each level is reached and what it improves. Level 1 comes with the account. */
const QUESTS: Record<number, { how: string; href: string | null; improves: string }> = {
  1: { how: "Create an account", href: null, improves: "Popular picks" },
  2: { how: "Take a quick quiz to get your class", href: "/quiz", improves: "Picks for your class" },
  3: { how: "Rate 5 books you've read", href: "/match/quiz", improves: "Real personalized matches" },
  4: {
    how: "Set your must-haves and hard no's",
    href: "/match/quiz",
    improves: "Heads-ups and precise filters",
  },
  5: {
    how: "Appraise 3 books you've read, or import your Goodreads ratings",
    href: "/account/import",
    improves: "The best matches, and better ones for everyone",
  },
};

export type QuestState = "done" | "active" | "locked";

/**
 * QUIZZES §4.2: the level title, an XP bar (level of 5), the one next step, and the quest log. A page
 * asks for at most one next step, so only the active quest links anywhere; later ones stay "???".
 */
export function levelInfo(level: number) {
  const quests = [1, 2, 3, 4, 5].map((l) => {
    const q = QUESTS[l] ?? { how: "", href: null, improves: "" };
    const state: QuestState = l <= level ? "done" : l === level + 1 ? "active" : "locked";
    return { level: l, title: LEVEL_TITLES[l] ?? "", ...q, state };
  });
  const active = quests.find((q) => q.state === "active");
  return {
    level,
    title: LEVEL_TITLES[level] ?? LEVEL_TITLES[1],
    xp: Math.round((level / 5) * 100),
    next: active?.href ? { text: active.how, href: active.href } : null,
    quests,
  };
}
