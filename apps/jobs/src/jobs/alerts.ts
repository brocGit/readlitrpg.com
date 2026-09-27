// Release-day alerts (DESIGN §13.6): from 11:00 UTC, each reader who asked for them gets at most one
// bundled email a day: what they follow that is out today (follows set to "on release day") and new
// books for saved matches and searches set to "as soon as one is added". A cursor in KV spreads the
// work over several runs and makes a re-run skip readers already handled today.

import { followedReleases, savedQueryPicks } from "@rlr/core/readers";
import { books, emailConsents, savedQueries, users } from "@rlr/core/schema";
import { renderReleaseAlert } from "@rlr/email";
import { and, asc, eq, gt, gte, isNull } from "drizzle-orm";
import {
  addDays,
  footerFor,
  isoDay,
  mailContext,
  marketingReady,
  pickBook,
  queueRendered,
  releaseBook,
} from "./mail";
import type { JobContext } from "./types";

const BATCH = 60;
const SRC = "src=alert";
const cursorKey = (day: string) => `email:release_alerts:${day}`;

export async function sendReleaseAlerts(ctx: JobContext): Promise<number> {
  const mc = await mailContext(ctx);
  if (!mc.settings["flags.newsletter_send"] || !(await marketingReady(mc))) return 0;
  const day = isoDay(mc.now);
  const cursor = (await mc.env.CONFIG.get(cursorKey(day))) ?? "";
  if (cursor === "done") return 0;

  const readers = await mc.db
    .select({ userId: emailConsents.userId, email: users.email })
    .from(emailConsents)
    .innerJoin(users, eq(users.id, emailConsents.userId))
    .where(
      and(
        eq(emailConsents.list, "release_alerts"),
        eq(emailConsents.status, "active"),
        cursor ? gt(emailConsents.userId, cursor) : undefined,
      ),
    )
    .orderBy(asc(emailConsents.userId))
    .limit(BATCH);

  // Books published in the last two days, for saved queries; each query only sees ones newer than
  // its last alert.
  const fresh = await mc.db
    .select({ id: books.id, publishedAt: books.publishedAt })
    .from(books)
    .where(
      and(
        eq(books.visibility, "published"),
        isNull(books.redirectTo),
        gte(books.publishedAt, addDays(mc.now, -2).toISOString()),
      ),
    )
    .limit(500);

  let sent = 0;
  for (const r of readers) {
    const out = (await followedReleases(mc.db, r.userId, { from: day, to: day, notify: ["instant"] })).filter(
      (x) => x.precision === "day" && x.status !== "cancelled",
    );
    const saved = await mc.db
      .select()
      .from(savedQueries)
      .where(and(eq(savedQueries.userId, r.userId), eq(savedQueries.alert, "instant")));
    const searches: { name: string; url: string; books: Awaited<ReturnType<typeof pickBook>>[] }[] = [];
    for (const s of saved) {
      const since = s.lastAlertedAt ?? s.createdAt;
      const only = new Set(fresh.filter((f) => (f.publishedAt ?? "") > since).map((f) => f.id));
      const picks = mc.matrix
        ? await savedQueryPicks(mc.db, mc.matrix, s, only, {
            options: mc.options,
            quizScale: mc.settings["quiz.fun_effect_importance"],
            limit: 3,
          })
        : [];
      await mc.db
        .update(savedQueries)
        .set({ lastAlertedAt: mc.now.toISOString() })
        .where(eq(savedQueries.id, s.id));
      if (picks.length)
        searches.push({
          name: s.name,
          url: `${mc.origin}/${s.kind === "match" ? "match/r" : "find"}?${s.params}`,
          books: await Promise.all(picks.map((p) => pickBook(mc, p, { src: SRC }))),
        });
    }
    if (out.length === 0 && searches.length === 0) continue;
    const { footer, headers } = await footerFor(mc, r.userId, "release_alerts");
    const email = renderReleaseAlert({
      releases: out.map((x) => releaseBook(mc, x, SRC)),
      savedSearches: searches,
      footer,
    });
    await queueRendered(mc, {
      to: r.email,
      userId: r.userId,
      template: "release_alert",
      issueId: null,
      stream: "marketing",
      ...email,
      headers,
    });
    sent++;
  }
  const last = readers.at(-1)?.userId;
  await mc.env.CONFIG.put(cursorKey(day), readers.length < BATCH || !last ? "done" : last, {
    expirationTtl: 3 * 86_400,
  });
  if (readers.length) mc.log.info("release_alerts.sent", { readers: readers.length, sent });
  return sent;
}
