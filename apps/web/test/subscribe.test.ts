import { createDb, type Db } from "@rlr/core/db";
import { decodeInputs } from "@rlr/core/match";
import { confirmSubscription, suppress } from "@rlr/core/readers";
import { emailConsents } from "@rlr/core/schema";
import { defaultSettings, type Settings } from "@rlr/core/settings";
import { createTestD1 } from "@rlr/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { type ConfirmMessage, parseSource, requestSubscribe, type SubscribeDeps } from "../src/lib/subscribe";

let db: Db;
let sent: ConfirmMessage[];
let settings: Settings;

function deps(overrides: Partial<SubscribeDeps> = {}): SubscribeDeps {
  return {
    db,
    settings: async () => settings,
    burstLimiter: { limit: async () => ({ success: true }) },
    ipSaltSeed: "salt",
    origin: "https://readlitrpg.com",
    deliver: async (m) => {
      sent.push(m);
    },
    ...overrides,
  };
}

const input = (email: unknown, extra: Record<string, unknown> = {}) => ({
  email,
  turnstileToken: "tok",
  ip: "203.0.113.9",
  plan: "weekly",
  source: "quiz:whats-your-litrpg-class:min-maxer",
  ...extra,
});

beforeEach(() => {
  db = createDb(createTestD1().asD1());
  sent = [];
  settings = defaultSettings();
});

describe("where a signup came from", () => {
  it("a quiz result names the class and seeds the quiz; 'just the list' drops the weekly email", () => {
    const weekly = parseSource("quiz:whats-your-litrpg-class:min-maxer", "weekly", null);
    expect(weekly.lists).toEqual(["reading_list", "weekly_digest"]);
    expect(weekly.inputs).toEqual({ quiz: { slug: "whats-your-litrpg-class", outcome: "min-maxer" } });
    expect(weekly.className).toBeTruthy();
    expect(parseSource("quiz:whats-your-litrpg-class:min-maxer", "list", null).lists).toEqual([
      "reading_list",
    ]);
  });

  it("unknown quizzes and outcomes fall back to a plain newsletter signup", () => {
    expect(parseSource("quiz:nope:tank", "weekly", null)).toMatchObject({
      source: "newsletter",
      lists: ["weekly_digest"],
    });
    expect(parseSource("quiz:whats-your-litrpg-class:nope", "weekly", null).source).toBe("newsletter");
    expect(parseSource("<script>", "weekly", null).source).toBe("newsletter");
  });
});

describe("subscribing", () => {
  it("emails a confirmation link that carries the quiz result, and records pending consent", async () => {
    expect(await requestSubscribe(deps(), input(" Reader@Example.com "))).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const message = sent[0] as ConfirmMessage;
    expect(message.to).toBe("reader@example.com");
    expect(message.listOnly).toBe(false);
    const url = new URL(message.url);
    expect(url.pathname).toBe("/subscribe/confirm");
    expect(decodeInputs(url.searchParams.get("p") ?? "")).toEqual({
      quiz: { slug: "whats-your-litrpg-class", outcome: "min-maxer" },
    });
    const consents = await db.select().from(emailConsents);
    expect(consents.map((c) => [c.list, c.status]).sort()).toEqual([
      ["reading_list", "pending"],
      ["weekly_digest", "pending"],
    ]);
    const confirmed = await confirmSubscription(db, url.searchParams.get("t") ?? "");
    expect(confirmed?.lists.sort()).toEqual(["reading_list", "weekly_digest"]);
  });

  it("answers the same for blocked, already-subscribed and rate-limited addresses, and sends nothing", async () => {
    await suppress(db, "blocked@example.com", "complaint");
    expect(await requestSubscribe(deps(), input("blocked@example.com"))).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) await requestSubscribe(deps(), input("often@example.com"));
    expect(sent.map((s) => s.to)).toEqual(["often@example.com", "often@example.com", "often@example.com"]);
  });

  it("checks the bot token and the burst limit", async () => {
    const failing = (async () => Response.json({ success: false })) as unknown as typeof fetch;
    expect(
      await requestSubscribe(deps({ turnstileSecret: "s", fetch: failing }), input("a@example.com")),
    ).toEqual({
      ok: false,
      code: "bot_check",
    });
    const limited = deps({ burstLimiter: { limit: async () => ({ success: false }) } });
    expect(await requestSubscribe(limited, input("a@example.com"))).toEqual({ ok: false, code: "slow_down" });
    expect(await requestSubscribe(deps(), input("nope"))).toEqual({ ok: false, code: "invalid_email" });
    expect(sent).toEqual([]);
  });

  it("refuses while the site is read-only", async () => {
    settings["flags.read_only_mode"] = true;
    expect(await requestSubscribe(deps(), input("a@example.com"))).toEqual({ ok: false, code: "read_only" });
  });
});
