import { createWebAuth } from "@rlr/core/auth";
import { createDb, type Db } from "@rlr/core/db";
import { defaultSettings, type Settings } from "@rlr/core/settings";
import { createTestD1, type TestD1 } from "@rlr/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { toConfirmUrl } from "../src/lib/magic-link";
import { requestMagicLink, type SigninDeps } from "../src/lib/signin";

let d1: TestD1;
let db: Db;
let sent: { email: string; url: string }[];
let settings: Settings;
let burstAllowed: boolean;

function deps(overrides: Partial<SigninDeps> = {}): SigninDeps {
  return {
    auth: createWebAuth({
      d1: d1.asD1(),
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseURL: "https://readlitrpg.com",
      rpID: "readlitrpg.com",
      sendMagicLink: async (m) => {
        sent.push(m);
      },
      signupsOpen: async () => true,
    }),
    db,
    settings: async () => settings,
    burstLimiter: { limit: async () => ({ success: burstAllowed }) },
    ipSaltSeed: "salt",
    ...overrides,
  };
}

const input = (email: unknown, extra: Record<string, unknown> = {}) => ({
  email,
  turnstileToken: "tok",
  ip: "203.0.113.9",
  headers: new Headers({ origin: "https://readlitrpg.com" }),
  ...extra,
});

beforeEach(() => {
  d1 = createTestD1();
  db = createDb(d1.asD1());
  sent = [];
  settings = defaultSettings();
  burstAllowed = true;
});

describe("requesting a sign-in link", () => {
  it("sends a link for a valid address, normalized", async () => {
    expect(await requestMagicLink(deps(), input("  Reader@Example.COM "))).toEqual({ ok: true });
    expect(sent.map((s) => s.email)).toEqual(["reader@example.com"]);
  });

  it("rejects bad addresses", async () => {
    expect(await requestMagicLink(deps(), input("not-an-email"))).toEqual({
      ok: false,
      code: "invalid_email",
    });
    expect(await requestMagicLink(deps(), input(42))).toEqual({ ok: false, code: "invalid_email" });
    expect(sent).toHaveLength(0);
  });

  it("requires a passing bot check when Turnstile is configured", async () => {
    const failing = async () => Response.json({ success: false });
    const passing = async () => Response.json({ success: true, action: "signin" });
    expect(
      await requestMagicLink(deps({ turnstileSecret: "s", fetch: failing }), input("a@example.com")),
    ).toEqual({
      ok: false,
      code: "bot_check",
    });
    expect(
      await requestMagicLink(deps({ turnstileSecret: "s", fetch: passing }), input("a@example.com")),
    ).toEqual({
      ok: true,
    });
  });

  it("fails closed when Turnstile is configured without a secret", async () => {
    expect(await requestMagicLink(deps({ turnstileSecret: "" }), input("a@example.com"))).toMatchObject({
      code: "bot_check",
    });
  });

  it("limits bursts per IP", async () => {
    burstAllowed = false;
    expect(await requestMagicLink(deps(), input("a@example.com"))).toEqual({ ok: false, code: "slow_down" });
  });

  it("caps links per address without revealing it", async () => {
    for (let i = 0; i < 3; i++) await requestMagicLink(deps(), input("a@example.com"));
    expect(await requestMagicLink(deps(), input("a@example.com"))).toEqual({ ok: true });
    expect(sent).toHaveLength(3);
  });

  it("refuses during read-only mode", async () => {
    settings = { ...settings, "flags.read_only_mode": true };
    expect(await requestMagicLink(deps(), input("a@example.com"))).toEqual({ ok: false, code: "read_only" });
  });
});

describe("confirmation links", () => {
  it("points at the confirm page, keeps redirects on-site and masks the address", () => {
    const url = new URL(
      toConfirmUrl(
        "https://readlitrpg.com/api/auth/magic-link/verify?token=abcDEF123_-xyz456789&callbackURL=%2Faccount&newUserCallbackURL=https%3A%2F%2Fevil.test",
        "reader@example.com",
        "https://readlitrpg.com",
      ),
    );
    expect(url.pathname).toBe("/signin/confirm");
    expect(url.searchParams.get("token")).toBe("abcDEF123_-xyz456789");
    expect(url.searchParams.get("next")).toBe("/account");
    expect(url.searchParams.get("new")).toBe("/account");
    expect(url.searchParams.get("e")).toBe("r***@example.com");
  });
});
