import { createWebAuth } from "@rlr/core/auth";
import { createDb, type Db } from "@rlr/core/db";
import { users } from "@rlr/core/schema";
import { defaultSettings } from "@rlr/core/settings";
import { createTestD1 } from "@rlr/core/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { checkAccess } from "../src/lib/access";
import { resolveAdminSession } from "../src/lib/admin-session";

const env = (overrides: Record<string, string> = {}) => ({
  ENVIRONMENT: "production",
  ACCESS_TEAM_DOMAIN: "https://readlitrpg.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  ACCESS_DEV_EMAIL: "owner@example.com",
  ...overrides,
});

describe("Access check", () => {
  it("uses the dev identity only for local environment AND localhost", async () => {
    const local = await checkAccess(new Request("http://localhost:4322/"), env({ ENVIRONMENT: "local" }));
    expect(local).toMatchObject({ ok: true, identity: { kind: "user", email: "owner@example.com" } });
    // Production vars on localhost: no bypass.
    expect((await checkAccess(new Request("http://localhost:4322/"), env())).ok).toBe(false);
    // Local vars on the real hostname: no bypass.
    const prodHost = await checkAccess(
      new Request("https://admin.readlitrpg.com/"),
      env({ ENVIRONMENT: "local" }),
    );
    expect(prodHost).toEqual({ ok: false, reason: "missing_assertion" });
  });
});

describe("admin session", () => {
  let db: Db;
  let auth: ReturnType<typeof createWebAuth>;
  let cookie: string;

  beforeEach(async () => {
    const d1 = createTestD1();
    db = createDb(d1.asD1());
    const sent: string[] = [];
    auth = createWebAuth({
      d1: d1.asD1(),
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseURL: "https://readlitrpg.com",
      rpID: "readlitrpg.com",
      sendMagicLink: async ({ url }) => {
        sent.push(url);
      },
      signupsOpen: async () => true,
    });
    await auth.api.signInMagicLink({ body: { email: "owner@example.com" }, headers: new Headers() });
    const verify = await auth.handler(
      new Request(sent[0] ?? "", { headers: { origin: "https://readlitrpg.com" } }),
    );
    cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });

  const resolve = (email: string) =>
    resolveAdminSession(new Request("https://admin.readlitrpg.com/", { headers: { cookie } }), {
      auth,
      db,
      access: { kind: "user", email, sub: "s" },
      settings: async () => defaultSettings(),
    });

  it("requires the admin flag", async () => {
    expect(await resolve("owner@example.com")).toBeNull();
    await db.update(users).set({ isAdmin: true }).where(eq(users.email, "owner@example.com"));
    expect(await resolve("owner@example.com")).toMatchObject({ email: "owner@example.com" });
  });

  it("requires the Access identity to be the same person", async () => {
    await db.update(users).set({ isAdmin: true }).where(eq(users.email, "owner@example.com"));
    expect(await resolve("someone-else@example.com")).toBeNull();
  });

  it("drops suspended admins and sessions older than the epoch", async () => {
    await db
      .update(users)
      .set({ isAdmin: true, state: "restricted" })
      .where(eq(users.email, "owner@example.com"));
    expect(await resolve("owner@example.com")).toBeNull();
    await db.update(users).set({ state: "active" }).where(eq(users.email, "owner@example.com"));
    const future = Math.floor(Date.now() / 1000) + 60;
    const withEpoch = await resolveAdminSession(
      new Request("https://admin.readlitrpg.com/", { headers: { cookie } }),
      {
        auth,
        db,
        access: { kind: "user", email: "owner@example.com", sub: "s" },
        settings: async () => ({ ...defaultSettings(), "session.epoch": future }),
      },
    );
    expect(withEpoch).toBeNull();
  });
});
