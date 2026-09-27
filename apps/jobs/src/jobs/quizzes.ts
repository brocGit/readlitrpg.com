// The quiz factory's hand-off to the owner (DESIGN §7.16): quizzes arrive in the code through a
// reviewed commit; this job asks for the publish decision in the inbox. Unless the owner retires a
// quiz first, the heartbeat publishes it when the veto window ends (QUIZZES §6.3).

import { announceNewQuizzes } from "@rlr/core/quiz";
import { loadSettings } from "@rlr/core/settings";
import type { JobContext } from "./types";

export async function announceQuizzes({ env, db, log, now }: JobContext): Promise<number> {
  const settings = await loadSettings({ db, kv: env.CONFIG, log });
  const opened = await announceNewQuizzes(db, settings["quiz.auto_publish_hours"], now);
  if (opened > 0) log.info("quiz.announced", { opened });
  return opened;
}
