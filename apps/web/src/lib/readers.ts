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

/** QUIZZES §4.2: the level title, the next step and a 0–100 XP bar. */
export function levelInfo(level: number) {
  const next: Record<number, { text: string; href: string } | null> = {
    1: { text: "Take a quick quiz to get your class", href: "/quiz" },
    2: { text: "Rate 5 books you've read", href: "/match/quiz" },
    3: { text: "Set your must-haves and hard no's", href: "/match/quiz" },
    4: { text: "Appraise 3 books you've read, or import your Goodreads ratings", href: "/account/import" },
    5: null,
  };
  return {
    level,
    title: LEVEL_TITLES[level] ?? LEVEL_TITLES[1],
    xp: Math.round(((level - 1) / 4) * 100),
    next: next[level] ?? null,
  };
}
