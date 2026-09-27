// Retention (DESIGN §16.2): expired sessions, sign-in tokens and rate counters, old job history, audit rows
// past seven years (oldest first, so the chain still verifies from its new first row), anonymous quiz
// takes after 90 days (their counts stay in quiz_daily; QUIZZES §4.3), the email send log after 90
// days, subscriptions never confirmed, and data exports past their link's life.

import { AUDIT_RETENTION_DAYS } from "@rlr/core/audit";
import { purgeAnonymousTakes } from "@rlr/core/quiz";
import { purgeUnconfirmed } from "@rlr/core/readers";
import {
  auditLog,
  dataExports,
  emailSends,
  jobRuns,
  rateCounters,
  sessions,
  verifications,
} from "@rlr/core/schema";
import { and, eq, lt } from "drizzle-orm";
import type { JobContext } from "./types";

export const JOB_RUN_RETENTION_DAYS = 90;
export const EMAIL_SEND_RETENTION_DAYS = 90;

export async function purgeExpired(ctx: JobContext): Promise<number> {
  const { db, now } = ctx;
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const results = await db.batch([
    db.delete(sessions).where(lt(sessions.expiresAt, now)),
    db.delete(verifications).where(lt(verifications.expiresAt, now)),
    db.delete(rateCounters).where(lt(rateCounters.expiresAt, now.toISOString())),
    db.delete(jobRuns).where(lt(jobRuns.queuedAt, daysAgo(JOB_RUN_RETENTION_DAYS))),
    // One day of margin so clock skew between the Worker and D1 never trips the delete trigger.
    db.delete(auditLog).where(lt(auditLog.createdAt, daysAgo(AUDIT_RETENTION_DAYS + 1))),
    db.delete(emailSends).where(lt(emailSends.createdAt, daysAgo(EMAIL_SEND_RETENTION_DAYS))),
  ]);
  const takes = await purgeAnonymousTakes(db, now);
  const unconfirmed = await purgeUnconfirmed(db, now);
  const exports = await expireExports(ctx);
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0) + takes + unconfirmed + exports;
}

/** Export files are deleted once their link expires; the row stays as "expired" for the account page. */
async function expireExports({ db, env, now }: JobContext): Promise<number> {
  const due = await db
    .select({ id: dataExports.id, key: dataExports.objectKey })
    .from(dataExports)
    .where(and(eq(dataExports.status, "ready"), lt(dataExports.expiresAt, now.toISOString())))
    .limit(200);
  for (const e of due) {
    if (e.key) await env.PRIVATE.delete(e.key);
    await db.update(dataExports).set({ status: "expired", objectKey: null }).where(eq(dataExports.id, e.id));
  }
  return due.length;
}
