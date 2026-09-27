import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyPath,
  isAutomated,
  referrerHost,
  rollupViews,
  toDataPoint,
  trafficSummary,
} from "../src/analytics";
import { createDb, type Db } from "../src/db";
import { createTestD1 } from "../src/testing";

describe("the beacon's filters", () => {
  it("names the page kind and subject, and never counts private pages", () => {
    expect(classifyPath("/")).toEqual({ kind: "home", key: "" });
    expect(classifyPath("/books/the-primal-hunter")).toEqual({ kind: "book", key: "the-primal-hunter" });
    expect(classifyPath("/quiz/whats-your-litrpg-class/r/min-maxer")).toEqual({
      kind: "quiz_result",
      key: "whats-your-litrpg-class",
    });
    expect(classifyPath("/quiz/whats-your-litrpg-class")).toEqual({
      kind: "quiz",
      key: "whats-your-litrpg-class",
    });
    expect(classifyPath("/match/r")).toEqual({ kind: "match", key: "r" });
    expect(classifyPath("/match")).toEqual({ kind: "match", key: "match" });
    expect(classifyPath("/account")).toBeNull();
    expect(classifyPath("/api/me")).toBeNull();
    expect(classifyPath("/signin/confirm")).toBeNull();
    expect(classifyPath("https://evil.example/")).toBeNull();
    expect(classifyPath("/something-new")).toEqual({ kind: "other", key: "" });
  });

  it("drops bots, link previewers and prefetches", () => {
    const h = (ua: string, extra: Record<string, string> = {}) => new Headers({ "user-agent": ua, ...extra });
    const reader =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
    expect(isAutomated(h(reader))).toBe(false);
    expect(isAutomated(h("Mozilla/5.0 (compatible; Googlebot/2.1)"))).toBe(true);
    expect(isAutomated(h("Discordbot/2.0"))).toBe(true);
    expect(isAutomated(h("curl/8.0"))).toBe(true);
    expect(isAutomated(h(reader, { "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isAutomated(new Headers())).toBe(true);
  });

  it("keeps only another site's host from the referrer", () => {
    expect(referrerHost("www.reddit.com", "readlitrpg.com")).toBe("reddit.com");
    expect(referrerHost("readlitrpg.com", "readlitrpg.com")).toBe("");
    expect(referrerHost("evil.com/<script>", "readlitrpg.com")).toBe("");
    expect(referrerHost(42, "readlitrpg.com")).toBe("");
    expect(toDataPoint({ kind: "book", key: "x", referrer: "reddit.com", country: "US" })).toEqual({
      indexes: ["book"],
      blobs: ["book", "x", "reddit.com", "US"],
      doubles: [1],
    });
  });
});

describe("stats.rollup", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(createTestD1().asD1());
  });

  it("copies daily totals from Analytics Engine, and a second run replaces rather than adds", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push({ url, body });
      if (body.includes("blob3 AS host"))
        return Response.json({ data: [{ day: "2026-10-01", host: "reddit.com", views: 7 }] });
      return Response.json({
        data: [
          { day: "2026-10-01 00:00:00", kind: "book", key: "the-primal-hunter", views: "12" },
          { day: "2026-10-01", kind: "home", key: "", views: 30 },
          { day: "2026-10-01", kind: "made-up", key: "x", views: 99 },
        ],
      });
    }) as typeof fetch;
    const deps = { accountId: "acc123", apiToken: "token", dataset: "rlr_events", fetch: fetcher };
    const now = new Date("2026-10-01T15:00:00Z");
    expect(await rollupViews(db, deps, 2, now)).toBe(2);
    expect(await rollupViews(db, deps, 2, now)).toBe(2);
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql");
    expect(calls[0]?.body).toContain("toDateTime('2026-09-30 00:00:00')");
    const summary = await trafficSummary(db, 7, now);
    expect(summary.byDay).toEqual([{ day: "2026-10-01", views: 42 }]);
    expect(summary.topPages).toEqual([{ kind: "book", key: "the-primal-hunter", views: 12 }]);
    expect(summary.topReferrers).toEqual([{ host: "reddit.com", views: 7 }]);
    await expect(rollupViews(db, { ...deps, dataset: "x; drop table" }, 2, now)).rejects.toThrow(/dataset/);
  });
});
