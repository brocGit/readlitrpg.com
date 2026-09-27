// End-to-end sign-in through Better Auth against the real migrations: proves the Drizzle schema,
// ULID ids, hashed magic-link tokens, cookie naming and the account-state hooks work together.

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdminAuth, createWebAuth } from "../src/auth";
import { createDb, type Db } from "../src/db";
import { sessions, users, verifications } from "../src/db/schema";
import { isUlid } from "../src/ids";
import { createTestD1, type TestD1 } from "../src/testing";

const BASE = "https://readlitrpg.com";
let d1: TestD1;
let db: Db;
let sent: { email: string; url: string }[];
let signupsOpen: boolean;

function webAuth() {
  return createWebAuth({
    d1: d1.asD1(),
    secret: "test-secret-that-is-at-least-32-characters-long",
    baseURL: BASE,
    rpID: "readlitrpg.com",
    sendMagicLink: async (m) => {
      sent.push(m);
    },
    signupsOpen: async () => signupsOpen,
  });
}

beforeEach(() => {
  d1 = createTestD1();
  db = createDb(d1.asD1());
  sent = [];
  signupsOpen = true;
});

async function requestLink(auth: ReturnType<typeof webAuth>, email: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, callbackURL: "/account" }),
    }),
  );
}

describe("web auth: magic link", () => {
  it("signs a new reader in with a ULID id, a hashed token and a secure cookie", async () => {
    const auth = webAuth();
    const res = await requestLink(auth, "Reader@Example.com");
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const link = new URL(sent[0]?.url ?? "");
    const token = link.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThanOrEqual(32);

    // The stored verification value must not contain the raw token.
    const stored = await db.select().from(verifications);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);

    const verify = await auth.handler(new Request(link, { headers: { origin: BASE } }));
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe(`${BASE}/account`);
    const setCookie = verify.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/__Secure-rlr\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const [user] = await db.select().from(users);
    expect(user?.email).toBe("reader@example.com");
    expect(user?.emailVerified).toBe(true);
    expect(isUlid(user?.id ?? "")).toBe(true);
    expect(user?.isAdmin).toBe(false);

    // The link is single-use.
    const again = await auth.handler(new Request(link, { headers: { origin: BASE } }));
    expect(again.headers.get("location")).toContain("error=");
  });

  it("the signups kill switch blocks new accounts", async () => {
    signupsOpen = false;
    const auth = webAuth();
    await requestLink(auth, "new@example.com");
    const link = new URL(sent[0]?.url ?? "");
    const verify = await auth.handler(new Request(link, { headers: { origin: BASE } }));
    expect(verify.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("a newsletter-only subscriber who signs in becomes a full account", async () => {
    await db
      .insert(users)
      .values({ id: "01SUBSCRIBER0000000000000", email: "sub@example.com", state: "subscriber" });
    const auth = webAuth();
    await requestLink(auth, "sub@example.com");
    const verify = await auth.handler(
      new Request(new URL(sent[0]?.url ?? ""), { headers: { origin: BASE } }),
    );
    expect(verify.headers.get("set-cookie") ?? "").toContain("session_token=");
    const [user] = await db.select().from(users).where(eq(users.email, "sub@example.com"));
    expect(user).toMatchObject({ id: "01SUBSCRIBER0000000000000", state: "active", emailVerified: true });
  });

  it("restricted accounts can't start sessions", async () => {
    const auth = webAuth();
    await requestLink(auth, "bad@example.com");
    await auth.handler(new Request(new URL(sent[0]?.url ?? ""), { headers: { origin: BASE } }));
    await db.delete(sessions);
    await db.update(users).set({ state: "restricted" }).where(eq(users.email, "bad@example.com"));
    await requestLink(auth, "bad@example.com");
    const verify = await auth.handler(
      new Request(new URL(sent[1]?.url ?? ""), { headers: { origin: BASE } }),
    );
    expect(verify.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});

describe("admin auth", () => {
  it("has no sign-up or magic-link path", async () => {
    const auth = createAdminAuth({
      d1: d1.asD1(),
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseURL: "https://admin.readlitrpg.com",
      rpID: "readlitrpg.com",
    });
    const res = await auth.handler(
      new Request("https://admin.readlitrpg.com/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://admin.readlitrpg.com" },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
    );
    expect(res.status).toBe(404);
    const signUp = await auth.handler(
      new Request("https://admin.readlitrpg.com/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://admin.readlitrpg.com" },
        body: JSON.stringify({ email: "owner@example.com", password: "x".repeat(20), name: "x" }),
      }),
    );
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
