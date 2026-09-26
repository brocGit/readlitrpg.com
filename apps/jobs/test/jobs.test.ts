import { appendAudit } from "@rlr/core/audit";
import { createDb, type Db } from "@rlr/core/db";
import { inboxItems, jobRuns, schedules, sessions, users } from "@rlr/core/schema";
import { createTestD1, TestKV } from "@rlr/core/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { emailProvider, HEARTBEAT_KV_KEY, queueKind, summarizeDeadLetter } from "../src/worker";

class FakeR2 {
  readonly objects = new Map<string, string>();
  async put(key: string, body: string) {
    this.objects.set(key, body);
    return {};
  }
}

class FakeQueue {
  readonly sent: unknown[] = [];
  async send(body: unknown) {
    this.sent.push(body);
    return {};
  }
}

interface FakeMessage {
  id: string;
  body: unknown;
  attempts: number;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function batch(queue: string, bodies: unknown[], attempts = 1) {
  const messages = bodies.map(
    (body, i): FakeMessage => ({
      id: `m${i}`,
      body,
      attempts,
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      },
    }),
  );
  return { queue, messages, ackAll() {}, retryAll() {} } as unknown as Omit<MessageBatch, "messages"> & {
    messages: FakeMessage[];
  } & MessageBatch;
}

let db: Db;
let env: Env & { BACKUPS: FakeR2; Q_JOBS: FakeQueue; CONFIG: TestKV };
const ctx = {
  waitUntil: (p: Promise<unknown>) => p,
  passThroughOnException() {},
} as unknown as ExecutionContext;

beforeEach(() => {
  const d1 = createTestD1();
  db = createDb(d1.asD1());
  env = {
    DB: d1.asD1(),
    CONFIG: new TestKV(),
    BACKUPS: new FakeR2(),
    Q_JOBS: new FakeQueue(),
    Q_EMAIL: new FakeQueue(),
    ENVIRONMENT: "local",
    EMAIL_PROVIDER: "console",
    EMAIL_FROM: "ReadLitRPG <hello@mail.readlitrpg.com>",
    SES_REGION: "us-east-1",
  } as unknown as typeof env;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("queue routing", () => {
  it("maps queue names to handlers", () => {
    expect(queueKind("rlr-jobs")).toBe("jobs");
    expect(queueKind("rlr-email")).toBe("email");
    expect(queueKind("rlr-staging-email")).toBe("email");
    expect(queueKind("rlr-email-dlq")).toBe("dlq");
    expect(queueKind("something")).toBeNull();
  });
});

describe("heartbeat", () => {
  it("seeds schedules, dispatches due jobs to Q_JOBS and records the tick", async () => {
    // First tick seeds schedules for the future; make one due and tick again.
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController,
      env,
      ctx,
    );
    expect(env.Q_JOBS.sent).toHaveLength(0);
    await db
      .update(schedules)
      .set({ nextRunAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(schedules.key, "audit.verify"));
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController,
      env,
      ctx,
    );
    expect(env.Q_JOBS.sent).toEqual([{ job: "audit.verify", runId: expect.any(String) }]);
    expect(await env.CONFIG.get(HEARTBEAT_KV_KEY)).toBeTruthy();
  });
});

describe("job runs", () => {
  it("runs a job once and records the outcome", async () => {
    await db.insert(users).values({ id: "u1", email: "a@example.com" });
    await db.insert(sessions).values({
      id: "s1",
      token: "t",
      userId: "u1",
      expiresAt: new Date(Date.now() - 1000),
    });
    await db.insert(jobRuns).values({ id: "r1", job: "retention.purge" });
    const b = batch("rlr-jobs", [{ job: "retention.purge", runId: "r1" }]);
    await worker.queue(b, env);
    expect(b.messages[0]?.acked).toBe(true);
    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ status: "succeeded", items: 1 });
    expect(await db.select().from(sessions)).toHaveLength(0);

    // A redelivery of the same run does nothing.
    const again = batch("rlr-jobs", [{ job: "retention.purge", runId: "r1" }]);
    await worker.queue(again, env);
    expect(again.messages[0]?.acked).toBe(true);
  });

  it("retries a failing job and marks the run failed", async () => {
    await db.insert(jobRuns).values({ id: "r2", job: "audit.verify" });
    // Break the chain: a row whose hash is wrong.
    await appendAudit(db, { actor: { type: "system" }, action: "x" });
    const d1 = env.DB as unknown as { sqlite: { exec(sql: string): void } };
    d1.sqlite.exec("DROP TRIGGER audit_log_no_update");
    d1.sqlite.exec("UPDATE audit_log SET action = 'tampered'");
    const b = batch("rlr-jobs", [{ job: "audit.verify", runId: "r2" }]);
    await worker.queue(b, env);
    expect(b.messages[0]?.retried).toBe(true);
    const [run] = await db.select().from(jobRuns);
    expect(run?.status).toBe("failed");
    const [alert] = await db.select().from(inboxItems);
    expect(alert).toMatchObject({ type: "security_alert", priority: 100 });
  });

  it("exports backups as NDJSON parts with a manifest", async () => {
    await db.insert(users).values([
      { id: "u1", email: "a@example.com" },
      { id: "u2", email: "b@example.com" },
    ]);
    await db.insert(jobRuns).values({ id: "r3", job: "backup.export" });
    await worker.queue(batch("rlr-jobs", [{ job: "backup.export", runId: "r3" }]), env);
    const keys = [...env.BACKUPS.objects.keys()];
    const usersPart = keys.find((k) => k.endsWith("/users/part-0001.ndjson"));
    expect(usersPart).toBeDefined();
    const lines = (env.BACKUPS.objects.get(usersPart ?? "") ?? "").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).email)).toEqual(["a@example.com", "b@example.com"]);
    expect(keys.some((k) => k.includes("/sessions/"))).toBe(false);
    const manifestKey = keys.find((k) => k.endsWith("manifest.json")) ?? "";
    const manifest = JSON.parse(env.BACKUPS.objects.get(manifestKey) ?? "{}");
    expect(manifest.tables.users.rows).toBe(2);
    expect(manifest.tables.users.parts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("email", () => {
  const job = (overrides: Record<string, unknown> = {}) => ({
    kind: "magic_link",
    to: "reader@example.com",
    url: "https://readlitrpg.com/signin/confirm?token=secret-token",
    requestedAt: new Date().toISOString(),
    ...overrides,
  });

  it("sends through the console provider locally", async () => {
    const b = batch("rlr-email", [job()]);
    await worker.queue(b, env);
    expect(b.messages[0]?.acked).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("secret-token"));
  });

  it("drops stale sign-in links and quarantines malformed jobs", async () => {
    const b = batch("rlr-email", [job({ requestedAt: "2000-01-01T00:00:00.000Z" }), { kind: "bogus" }]);
    await worker.queue(b, env);
    expect(b.messages.every((m) => m.acked)).toBe(true);
    const items = await db.select().from(inboxItems);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain("secret-token");
  });

  it("refuses the console provider outside local", () => {
    expect(() => emailProvider({ ...env, ENVIRONMENT: "production" })).toThrow(/local development only/);
    expect(() => emailProvider({ ...env, ENVIRONMENT: "production", EMAIL_PROVIDER: "ses" })).toThrow(
      /SES credentials/,
    );
  });
});

describe("dead letters", () => {
  it("open one inbox item per message without copying secrets", async () => {
    const body = { kind: "magic_link", to: "reader@example.com", url: "https://x/?token=secret-token" };
    expect(summarizeDeadLetter("rlr-email-dlq", body)).toEqual({
      kind: "magic_link",
      to: "r***@example.com",
    });
    await worker.queue(batch("rlr-email-dlq", [body]), env);
    await worker.queue(batch("rlr-email-dlq", [body]), env);
    const items = await db.select().from(inboxItems);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain("secret-token");
    expect(JSON.stringify(items)).not.toContain("reader@example.com");
  });
});
