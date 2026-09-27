// Retention (DESIGN §16.2): expired sessions, sign-in tokens and rate counters, old job history, audit rows
// past seven years (oldest first, so the chain still verifies from its new first row), and anonymous quiz
// takes after 90 days (their counts stay in quiz_daily; QUIZZES §4.3).

import { AUDIT_RETENTION_DAYS } from "@rlr/core/audit";
import { purgeAnonymousTakes } from "@rlr/core/quiz";
import { auditLog, jobRuns, rateCounters, sessions, verifications } from "@rlr/core/schema";
import { lt } from "drizzle-orm";
import type { JobContext } from "./types";

export const JOB_RUN_RETENTION_DAYS = 90;

export async function purgeExpired({ db, now }: JobContext): Promise<number> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const results = await db.batch([
    db.delete(sessions).where(lt(sessions.expiresAt, now)),
    db.delete(verifications).where(lt(verifications.expiresAt, now)),
    db.delete(rateCounters).where(lt(rateCounters.expiresAt, now.toISOString())),
    db.delete(jobRuns).where(lt(jobRuns.queuedAt, daysAgo(JOB_RUN_RETENTION_DAYS))),
    // One day of margin so clock skew between the Worker and D1 never trips the delete trigger.
    db.delete(auditLog).where(lt(auditLog.createdAt, daysAgo(AUDIT_RETENTION_DAYS + 1))),
  ]);
  const takes = await purgeAnonymousTakes(db, now);
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0) + takes;
}
