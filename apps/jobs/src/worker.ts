// The jobs Worker (DESIGN §4.2, §7.9). No public routes.
//
//   scheduled  every 5 minutes: the heartbeat dispatches due jobs to Q_JOBS and runs inbox defaults
//   queue      rlr-jobs: run one job; rlr-email: send email; *-dlq: open an Owner Inbox item

import { createLogger, type Logger, maskEmail } from "@rlr/core";
import { createDb, type Db } from "@rlr/core/db";
import { openInboxItem, runInboxDefaults } from "@rlr/core/inbox";
import { publishDueQuizzes } from "@rlr/core/quiz";
import {
  finishJobRun,
  HEARTBEAT_KV_KEY,
  isJobKey,
  type JobKey,
  type JobMessage,
  requeueJobRun,
  runHeartbeat,
  startJobRun,
} from "@rlr/core/scheduler";
import {
  buildEmail,
  ConsoleProvider,
  type EmailProvider,
  emailJobSchema,
  SesError,
  SesProvider,
} from "@rlr/email";
import { verifyAudit } from "./jobs/audit-verify";
import { exportBackup } from "./jobs/backup";
import { buildQueue, checkCitations, watchdog } from "./jobs/editorial";
import { enrichCatalog } from "./jobs/enrich";
import { importCatalog } from "./jobs/import";
import { buildMatchModel } from "./jobs/match";
import { findCovers, processMedia } from "./jobs/media";
import { renderShareImages } from "./jobs/og";
import { announceQuizzes } from "./jobs/quizzes";
import { purgeExpired } from "./jobs/retention";
import { syncTaxonomyJob } from "./jobs/taxonomy-sync";
import type { JobHandler } from "./jobs/types";
import { updateVectors } from "./jobs/vectors";

export const JOB_HANDLERS: Record<JobKey, JobHandler> = {
  "backup.export": exportBackup,
  "audit.verify": verifyAudit,
  "retention.purge": purgeExpired,
  "taxonomy.sync": syncTaxonomyJob,
  "catalog.enrich": enrichCatalog,
  "catalog.import": importCatalog,
  "editorial.queue": buildQueue,
  "editorial.watchdog": watchdog,
  "editorial.citations": checkCitations,
  "vectors.update": updateVectors,
  "media.covers": findCovers,
  "media.process": processMedia,
  "og.render": renderShareImages,
  "quiz.announce": announceQuizzes,
  "match.model_build": buildMatchModel,
};

type QueueKind = "jobs" | "email" | "dlq";

export function queueKind(name: string): QueueKind | null {
  if (name.endsWith("-dlq")) return "dlq";
  if (/(^|-)email(-|$)/.test(name)) return "email";
  if (/(^|-)jobs(-|$)/.test(name)) return "jobs";
  return null;
}

export default {
  async scheduled(controller, env, ctx) {
    const log = createLogger({ worker: "jobs", cron: controller.cron });
    const db = createDb(env.DB);
    const now = new Date(controller.scheduledTime);
    const result = await runHeartbeat({
      db,
      now,
      dispatch: async (message) => {
        await env.Q_JOBS.send(message);
      },
    });
    ctx.waitUntil(env.CONFIG.put(HEARTBEAT_KV_KEY, now.toISOString()));
    // Inbox default actions whose deadline has passed (DESIGN §7.9). A failure here must not stop
    // the scheduler, so it is logged and retried on the next tick.
    let defaults = 0;
    try {
      defaults = await runInboxDefaults(db, now);
      const published = await publishDueQuizzes(db, now);
      defaults += published.length;
      if (published.length) log.info("quiz.auto_published", { quizzes: published });
    } catch (error) {
      log.error("heartbeat.inbox_defaults_failed", { error });
    }
    if (result.dispatched.length || result.failed.length || defaults)
      log.info("heartbeat", { ...result, defaults });
    if (result.failed.length) log.error("heartbeat.dispatch_failed", { failed: result.failed });
  },

  async queue(batch, env) {
    const log = createLogger({ worker: "jobs", queue: batch.queue });
    const db = createDb(env.DB);
    switch (queueKind(batch.queue)) {
      case "jobs":
        return runJobs(batch as MessageBatch<JobMessage>, env, db, log);
      case "email":
        return sendEmails(batch, env, db, log);
      case "dlq":
        return deadLetters(batch, db, log);
      default:
        log.error("queue.unknown", { queue: batch.queue });
        batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

async function runJobs(batch: MessageBatch<JobMessage>, env: Env, db: Db, log: Logger) {
  for (const message of batch.messages) {
    const { job, runId } = message.body;
    const jobLog = log.child({ job, run_id: runId, attempt: message.attempts });
    if (!isJobKey(job)) {
      jobLog.error("job.unknown");
      message.ack();
      continue;
    }
    if (message.attempts > 1) await requeueJobRun(db, runId);
    if (!(await startJobRun(db, runId))) {
      // Already finished (a redelivery after success): nothing to do.
      message.ack();
      continue;
    }
    try {
      const items = await JOB_HANDLERS[job]({ env, db, log: jobLog, now: new Date() });
      await finishJobRun(db, runId, { ok: true, items });
      jobLog.info("job.succeeded", { items });
      message.ack();
    } catch (error) {
      await finishJobRun(db, runId, { ok: false, error: String(error) });
      jobLog.error("job.failed", { error });
      message.retry({ delaySeconds: Math.min(60 * message.attempts, 600) });
    }
  }
}

export function emailProvider(env: Env): EmailProvider {
  if (env.EMAIL_PROVIDER === "console") {
    if (env.ENVIRONMENT !== "local")
      throw new Error("the console email provider is for local development only");
    return new ConsoleProvider();
  }
  if (!env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY) throw new Error("SES credentials are not set");
  return new SesProvider({
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    region: env.SES_REGION,
    from: env.EMAIL_FROM,
    configurationSets: { transactional: "rlr-transactional", marketing: "rlr-marketing" },
  });
}

async function sendEmails(batch: MessageBatch, env: Env, db: Db, log: Logger) {
  const provider = emailProvider(env);
  for (const message of batch.messages) {
    const parsed = emailJobSchema.safeParse(message.body);
    if (!parsed.success) {
      // A malformed message will never send. Record it without its contents and move on.
      log.error("email.malformed", { message_id: message.id });
      await openInboxItem(db, {
        type: "system_alert",
        title: "Malformed email job dropped",
        payload: { queue: batch.queue, messageId: message.id, issues: parsed.error.issues.length },
        dedupeKey: `email.malformed:${message.id}`,
      });
      message.ack();
      continue;
    }
    const email = buildEmail(parsed.data);
    if (!email) {
      log.warn("email.stale_dropped", { kind: parsed.data.kind });
      message.ack();
      continue;
    }
    try {
      const result = await provider.send(email);
      log.info("email.sent", {
        kind: parsed.data.kind,
        provider: result.provider,
        provider_id: result.messageId,
      });
      message.ack();
    } catch (error) {
      if (error instanceof SesError && !error.retryable) {
        log.error("email.rejected", { kind: parsed.data.kind, status: error.status });
        message.ack();
      } else {
        log.warn("email.retry", { kind: parsed.data.kind, attempt: message.attempts, error });
        message.retry({ delaySeconds: 30 * message.attempts });
      }
    }
  }
}

/** Describe a dead-lettered message without copying secrets (sign-in URLs) into the inbox. */
export function summarizeDeadLetter(queue: string, body: unknown): Record<string, unknown> {
  const kind = queueKind(queue.replace(/-dlq$/, ""));
  if (kind === "email") {
    const b = (body ?? {}) as { kind?: unknown; to?: unknown };
    return {
      kind: typeof b.kind === "string" ? b.kind : "unknown",
      to: typeof b.to === "string" ? maskEmail(b.to) : "unknown",
    };
  }
  const text = JSON.stringify(body ?? null);
  return { body: text.length > 2000 ? `${text.slice(0, 2000)}…` : text };
}

async function deadLetters(batch: MessageBatch, db: Db, log: Logger) {
  for (const message of batch.messages) {
    const summary = summarizeDeadLetter(batch.queue, message.body);
    const item = await openInboxItem(db, {
      type: "dlq_message",
      title: `A ${batch.queue.replace(/-dlq$/, "")} message failed every retry`,
      subjectType: "queue",
      subjectId: batch.queue,
      priority: 80,
      payload: { messageId: message.id, attempts: message.attempts, ...summary },
      dedupeKey: `dlq:${batch.queue}:${message.id}`,
    });
    log.error("dlq.received", { message_id: message.id, inbox_id: item?.id ?? "duplicate" });
    message.ack();
  }
}
