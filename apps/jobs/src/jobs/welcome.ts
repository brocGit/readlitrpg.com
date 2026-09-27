// The welcome sequence (QUIZZES §3.4): E1 the reading list on confirmation, E2 on day 2 (rate the
// classics), E3 on day 5 (new and upcoming, follow a series, another quiz), E4 on day 9 (Patch Notes
// starts). "Just the list" readers get E1 only. A step whose ask the reader already did is skipped.

import { liveQuizzes, READER_CLASSES } from "@rlr/core/quiz";
import {
  advance,
  dueSteps,
  effectiveInputs,
  endSequence,
  getReaderProfile,
  picksFor,
  profileFor,
} from "@rlr/core/readers";
import { follows, quizTakes, releases, users } from "@rlr/core/schema";
import { renderWelcome1, renderWelcome2, renderWelcome3, renderWelcome4 } from "@rlr/email";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  activeLists,
  addDays,
  footerFor,
  isoDay,
  type MailContext,
  mailContext,
  marketingReady,
  pickBook,
  queueRendered,
} from "./mail";
import type { JobContext } from "./types";

const BATCH = 25;
const SRC = "src=welcome";

export async function sendWelcomeSteps(ctx: JobContext): Promise<number> {
  const mc = await mailContext(ctx);
  if (!(await marketingReady(mc))) return 0;
  const due = await dueSteps(mc.db, mc.now, BATCH);
  let sent = 0;
  for (const row of due) {
    const lists = await activeLists(mc, row.userId);
    // Welcome mail rides on the reading-list or weekly consent; without either, the sequence ends.
    const list = lists.has("reading_list")
      ? "reading_list"
      : lists.has("weekly_digest")
        ? "weekly_digest"
        : null;
    const [user] = await mc.db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
    if (!list || !user) {
      await endSequence(mc.db, row.userId, row.sequence, mc.now);
      continue;
    }
    const job = await buildStep(mc, row.userId, row.step, list, lists.has("weekly_digest"));
    if (job) {
      await queueRendered(mc, {
        to: user.email,
        userId: row.userId,
        issueId: null,
        stream: "marketing",
        ...job,
      });
      sent++;
    }
    await advance(mc.db, row, mc.now);
  }
  if (due.length) mc.log.info("welcome.sent", { due: due.length, sent });
  return sent;
}

type Built = {
  template: "welcome_1" | "welcome_2" | "welcome_3" | "welcome_4";
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
};

async function buildStep(
  mc: MailContext,
  userId: string,
  step: number,
  list: "reading_list" | "weekly_digest",
  weekly: boolean,
): Promise<Built | null> {
  const profile = await getReaderProfile(mc.db, userId);
  const className = READER_CLASSES.find((c) => c.key === profile.readerClass)?.name ?? null;
  const { footer, headers } = await footerFor(mc, userId, list);
  const scale = mc.settings["quiz.fun_effect_importance"];

  if (step === 1) {
    const picks = mc.matrix
      ? await picksFor(mc.db, mc.matrix, profileFor(mc.matrix, await effectiveInputs(mc.db, userId), scale), {
          options: mc.options,
          quizScale: scale,
          limit: 10,
        })
      : [];
    const books = await Promise.all(picks.map((p) => pickBook(mc, p, { src: SRC, userId, marks: true })));
    const r = renderWelcome1({
      className,
      best: books.slice(0, 3),
      more: books.slice(3),
      matchUrl: `${mc.origin}/account/preferences`,
      footer,
    });
    return { template: "welcome_1", ...r, headers };
  }

  if (step === 2) {
    // Skip rule: already rated books (level 3+), so "rate 12 classics" has nothing to add.
    if (profile.level >= 3) return null;
    return {
      template: "welcome_2",
      ...renderWelcome2({ rateUrl: `${mc.origin}/match/quiz?${SRC}`, footer }),
      headers,
    };
  }

  if (step === 3) {
    const soon = await mc.db
      .selectDistinct({ id: releases.bookId })
      .from(releases)
      .where(
        and(
          gte(releases.date, isoDay(addDays(mc.now, -14))),
          lte(releases.date, isoDay(addDays(mc.now, 60))),
          sql`${releases.status} != 'cancelled'`,
        ),
      )
      .limit(500);
    const picks =
      mc.matrix && soon.length
        ? await picksFor(
            mc.db,
            mc.matrix,
            profileFor(mc.matrix, await effectiveInputs(mc.db, userId), scale),
            {
              options: mc.options,
              quizScale: scale,
              limit: 5,
              only: new Set(soon.map((s) => s.id)),
            },
          )
        : [];
    const upcoming = await Promise.all(picks.map((p) => pickBook(mc, p, { src: SRC })));
    const taken = new Set(
      (
        await mc.db.select({ slug: quizTakes.quizSlug }).from(quizTakes).where(eq(quizTakes.userId, userId))
      ).map((t) => t.slug),
    );
    const next = (await liveQuizzes(mc.db)).find((q) => !taken.has(q.slug) && q.kind === "fun");
    const [following] = await mc.db
      .select({ n: sql<number>`count(*)` })
      .from(follows)
      .where(eq(follows.userId, userId));
    const r = renderWelcome3({
      className,
      upcoming,
      // Skip rule: someone already following things is pointed at their list instead.
      followUrl: (following?.n ?? 0) > 0 ? `${mc.origin}/account/follows` : `${mc.origin}/new?${SRC}`,
      quiz: next ? { title: next.title, url: `${mc.origin}/quiz/${next.slug}?src=newsletter` } : null,
      footer,
    });
    return { template: "welcome_3", ...r, headers };
  }

  if (step === 4) {
    // E4 introduces Patch Notes; readers who chose "just the list" never reach it, and anyone who
    // has since turned the weekly email off doesn't need it.
    if (!weekly) return null;
    return {
      template: "welcome_4",
      ...renderWelcome4({ preferencesUrl: `${mc.origin}/account/email`, footer }),
      headers,
    };
  }
  return null;
}
