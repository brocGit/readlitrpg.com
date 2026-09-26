import { describe, expect, it } from "vitest";
import { CronError, nextCronTime, parseCron } from "../src/scheduler/cron";

const next = (expr: string, after: string) => nextCronTime(expr, new Date(after)).toISOString();

describe("cron", () => {
  it("every 5 minutes", () => {
    expect(next("*/5 * * * *", "2026-09-26T12:03:10Z")).toBe("2026-09-26T12:05:00.000Z");
    expect(next("*/5 * * * *", "2026-09-26T12:05:00Z")).toBe("2026-09-26T12:10:00.000Z");
  });

  it("daily at a fixed time rolls to tomorrow once passed", () => {
    expect(next("30 5 * * *", "2026-09-26T05:29:59Z")).toBe("2026-09-26T05:30:00.000Z");
    expect(next("30 5 * * *", "2026-09-26T05:30:00Z")).toBe("2026-09-27T05:30:00.000Z");
  });

  it("weekly on a weekday (Sun 03:00)", () => {
    // 2026-09-26 is a Saturday.
    expect(next("0 3 * * 0", "2026-09-26T12:00:00Z")).toBe("2026-09-27T03:00:00.000Z");
    expect(next("0 3 * * 7", "2026-09-26T12:00:00Z")).toBe("2026-09-27T03:00:00.000Z");
  });

  it("monthly on the 1st and 15th", () => {
    expect(next("0 11 1,15 * *", "2026-09-26T12:00:00Z")).toBe("2026-10-01T11:00:00.000Z");
    expect(next("0 11 1,15 * *", "2026-10-01T11:00:00Z")).toBe("2026-10-15T11:00:00.000Z");
  });

  it("ranges and stepped ranges", () => {
    expect(next("0 9-17/4 * * 1-5", "2026-09-28T09:00:00Z")).toBe("2026-09-28T13:00:00.000Z");
    expect(next("0 9-17/4 * * 1-5", "2026-09-28T17:00:00Z")).toBe("2026-09-29T09:00:00.000Z");
  });

  it("day-of-month OR day-of-week when both are restricted", () => {
    // The 1st of the month, or any Monday.
    expect(next("0 0 1 * 1", "2026-09-26T00:00:00Z")).toBe("2026-09-28T00:00:00.000Z");
  });

  it("handles month and year boundaries and leap days", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("59 23 31 12 *", "2026-12-31T23:58:00Z")).toBe("2026-12-31T23:59:00.000Z");
  });

  it("rejects bad expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(CronError);
    expect(() => parseCron("60 * * * *")).toThrow(CronError);
    expect(() => parseCron("*/0 * * * *")).toThrow(CronError);
    expect(() => parseCron("a * * * *")).toThrow(CronError);
    expect(() => nextCronTime("0 0 31 2 *", new Date())).toThrow(CronError);
  });
});
