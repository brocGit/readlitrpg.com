import { describe, expect, it } from "vitest";
import { countdown, localToday } from "../src/lib/countdown";

describe("countdown", () => {
  const today = "2026-09-28";
  it("counts down to a release whose day is known", () => {
    expect(countdown("2026-09-28", today)).toEqual({ text: "Out today!", tone: "today" });
    expect(countdown("2026-09-29", today)).toEqual({ text: "Tomorrow", tone: "soon" });
    expect(countdown("2026-10-05", today)).toEqual({ text: "in 7 days", tone: "soon" });
    expect(countdown("2026-10-06", today)).toEqual({ text: "in 8 days", tone: "later" });
    expect(countdown("2026-10-12", today)).toEqual({ text: "in 2 weeks", tone: "later" });
  });

  it("says nothing for past releases, far-off ones or bad dates", () => {
    expect(countdown("2026-09-27", today)).toBeNull();
    expect(countdown("2026-12-31", today)).toBeNull();
    expect(countdown("soon", today)).toBeNull();
  });

  it("crosses month and year ends by calendar days", () => {
    expect(countdown("2027-01-01", "2026-12-31")?.text).toBe("Tomorrow");
  });

  it("formats the reader's date", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
