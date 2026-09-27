import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { jobRuns, schedules } from "../src/db/schema";
import {
  claimDueSchedules,
  ensureSchedules,
  finishJobRun,
  type JobDef,
  requestRunNow,
  requeueJobRun,
  runHeartbeat,
  startJobRun,
  updateSchedule,
} from "../src/scheduler";
import { createTestD1 } from "../src/testing";

const JOBS: JobDef[] = [
  { key: "every5", cron: "*/5 * * * *", description: "" },
  { key: "daily", cron: "30 5 * * *", description: "" },
];

let db: Db;
beforeEach(() => {
  db = createDb(createTestD1().asD1());
});

const t = (iso: string) => new Date(iso);

describe("scheduler", () => {
  it("seeds any number of jobs within D1's parameter limit", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      key: `job${i}`,
      cron: "0 * * * *",
      description: "",
    }));
    await ensureSchedules(db, many, t("2026-09-26T12:01:00Z"));
    expect(await db.select().from(schedules)).toHaveLength(60);
  });

  it("seeds schedules without overwriting edits", async () => {
    await ensureSchedules(db, JOBS, t("2026-09-26T12:01:00Z"));
    await updateSchedule(db, "daily", { cronExpr: "0 6 * * *" }, t("2026-09-26T12:01:00Z"));
    await ensureSchedules(db, JOBS, t("2026-09-26T12:02:00Z"));
    const rows = await db.select().from(schedules);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === "daily")?.cronExpr).toBe("0 6 * * *");
    expect(rows.find((r) => r.key === "every5")?.nextRunAt).toBe("2026-09-26T12:05:00.000Z");
  });

  it("dispatches due jobs once and schedules the next run", async () => {
    await ensureSchedules(db, JOBS, t("2026-09-26T12:01:00Z"));
    const sent: string[] = [];
    const dispatch = async (m: { job: string }) => {
      sent.push(m.job);
    };
    const r1 = await runHeartbeat({ db, jobs: JOBS, dispatch, now: t("2026-09-26T12:05:00Z") });
    expect(sent).toEqual(["every5"]);
    expect(r1.dispatched[0]?.next).toBe("2026-09-26T12:10:00.000Z");
    // A second tick in the same slot dispatches nothing.
    await runHeartbeat({ db, jobs: JOBS, dispatch, now: t("2026-09-26T12:05:30Z") });
    expect(sent).toEqual(["every5"]);
    const runs = await db.select().from(jobRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
  });

  it("two heartbeats racing: only one wins the lease", async () => {
    await ensureSchedules(db, JOBS, t("2026-09-26T12:01:00Z"));
    const now = t("2026-09-26T12:05:00Z");
    const a = await claimDueSchedules(db, "A", now);
    const b = await claimDueSchedules(db, "B", now);
    expect(a.map((r) => r.key)).toEqual(["every5"]);
    expect(b).toEqual([]);
  });

  it("an expired lease can be taken over", async () => {
    await ensureSchedules(db, JOBS, t("2026-09-26T12:01:00Z"));
    await claimDueSchedules(db, "A", t("2026-09-26T12:05:00Z"));
    const later = await claimDueSchedules(db, "B", t("2026-09-26T12:08:00Z"));
    expect(later.map((r) => r.key)).toEqual(["every5"]);
  });

  it("a failed dispatch releases the lease and marks the run failed", async () => {
    await ensureSchedules(db, JOBS, t("2026-09-26T12:01:00Z"));
    const result = await runHeartbeat({
      db,
      jobs: JOBS,
      now: t("2026-09-26T12:05:00Z"),
      dispatch: async () => {
        throw new Error("queue down");
      },
    });
    expect(result.failed).toHaveLength(1);
    const [row] = await db.select().from(schedules).where(eq(schedules.key, "every5"));
    expect(row?.lockUntil).toBeNull();
    expect(row?.nextRunAt).toBe("2026-09-26T12:05:00.000Z");
    const [run] = await db.select().from(jobRuns);
    expect(run?.status).toBe("failed");
  });

  it("paused jobs don't run; run-now makes a job due", async () => {
    await ensureSchedules(db, JOBS, t("2026-09-26T12:01:00Z"));
    await updateSchedule(db, "every5", { enabled: false });
    expect(await claimDueSchedules(db, "A", t("2026-09-26T12:05:00Z"))).toEqual([]);
    await requestRunNow(db, "daily", t("2026-09-26T12:06:00Z"));
    const claimed = await claimDueSchedules(db, "A", t("2026-09-26T12:06:00Z"));
    expect(claimed.map((r) => r.key)).toEqual(["daily"]);
  });

  it("job runs start once, even if the queue redelivers", async () => {
    await db.insert(jobRuns).values({ id: "run1", job: "every5" });
    expect(await startJobRun(db, "run1")).toBe(true);
    expect(await startJobRun(db, "run1")).toBe(false);
    await finishJobRun(db, "run1", { ok: false, error: "boom" });
    await requeueJobRun(db, "run1");
    expect(await startJobRun(db, "run1")).toBe(true);
    await finishJobRun(db, "run1", { ok: true, items: 3 });
    await requeueJobRun(db, "run1");
    expect(await startJobRun(db, "run1")).toBe(false);
    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ status: "succeeded", items: 3, trigger: "retry" });
  });

  it("rejects a bad cron on update", async () => {
    await ensureSchedules(db, JOBS);
    await expect(updateSchedule(db, "daily", { cronExpr: "nope" })).rejects.toThrow();
  });
});
