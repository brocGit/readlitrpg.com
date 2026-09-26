import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { rateCounters } from "../src/db/schema";
import { hitAll, hitWindow, SIGNIN_LIMITS } from "../src/ratelimit";
import { verifyTurnstile } from "../src/security";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(() => {
  db = createDb(createTestD1().asD1());
});

describe("window counters", () => {
  it("allows up to the limit per window, then resets", async () => {
    const rule = SIGNIN_LIMITS.perEmail;
    const t0 = new Date("2026-09-26T12:00:10Z");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hitWindow(db, rule, "a@example.com", t0));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]?.retryAfter).toBe(15 * 60 - 10);
    const next = await hitWindow(db, rule, "a@example.com", new Date("2026-09-26T12:15:00Z"));
    expect(next).toMatchObject({ ok: true, count: 1 });
  });

  it("stores hashed keys only", async () => {
    await hitWindow(db, SIGNIN_LIMITS.perIp, "203.0.113.9");
    const rows = await db.select().from(rateCounters);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
  });

  it("hitAll fails if any rule is over", async () => {
    const now = new Date("2026-09-26T12:00:00Z");
    for (let i = 0; i < 3; i++) await hitWindow(db, SIGNIN_LIMITS.perEmail, "b@example.com", now);
    const result = await hitAll(
      db,
      [
        { rule: SIGNIN_LIMITS.perEmail, subject: "b@example.com" },
        { rule: SIGNIN_LIMITS.perIp, subject: "ip" },
      ],
      now,
    );
    expect(result).toMatchObject({ ok: false, rule: "signin.email" });
  });
});

describe("turnstile", () => {
  const ok = async () => Response.json({ success: true, action: "signin" });
  it("passes a verified token and checks the action", async () => {
    expect((await verifyTurnstile("tok", { secret: "s", fetch: ok })).ok).toBe(true);
    expect((await verifyTurnstile("tok", { secret: "s", fetch: ok, expectedAction: "other" })).ok).toBe(
      false,
    );
  });
  it("fails closed", async () => {
    expect((await verifyTurnstile("", { secret: "s", fetch: ok })).ok).toBe(false);
    expect((await verifyTurnstile("tok", { secret: "", fetch: ok })).ok).toBe(false);
    const down = async () => {
      throw new Error("down");
    };
    expect((await verifyTurnstile("tok", { secret: "s", fetch: down })).ok).toBe(false);
    const rejected = async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile("tok", { secret: "s", fetch: rejected })).toEqual({
      ok: false,
      errors: ["invalid-input-response"],
    });
  });
});
