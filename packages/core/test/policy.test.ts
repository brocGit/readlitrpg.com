// The permission matrix in DESIGN §2.3, encoded as a table. If the design changes, change the table.

import { describe, expect, it } from "vitest";
import { type Action, type Actor, can, checkRoute, type Decision, type Resource } from "../src/policy";

const NOW = new Date("2026-09-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const visitor: Actor = { kind: "visitor" };
const subscriber: Actor = { kind: "subscriber", userId: "S" };
const reader: Actor = {
  kind: "user",
  userId: "R",
  state: "active",
  emailVerified: true,
  createdAt: daysAgo(30),
  authors: [],
  publishers: [],
};
const author: Actor = {
  ...reader,
  userId: "A",
  authors: [{ authorId: "auth1", role: "owner", trust: "T0" }],
};
const verifiedAuthor: Actor = {
  ...reader,
  userId: "V",
  authors: [{ authorId: "auth2", role: "owner", trust: "T1" }],
};
const restrictedAuthor: Actor = {
  ...reader,
  userId: "X",
  authors: [{ authorId: "auth3", role: "owner", trust: "T-1" }],
};
const publisher: Actor = {
  ...reader,
  userId: "P",
  publishers: [{ publisherId: "pub1", role: "owner", trust: "T1", authorIds: ["auth4", "auth5"] }],
};
const admin: Actor = { kind: "admin", userId: "O", lastAuthAt: new Date(NOW.getTime() - 5 * 60_000) };
const staleAdmin: Actor = { kind: "admin", userId: "O", lastAuthAt: new Date(NOW.getTime() - 60 * 60_000) };

const ownBook = (a: string): Resource => ({ type: "book", authorIds: [a] });
const otherBook: Resource = { type: "book", authorIds: ["someone-else"] };

const ok = (d: Decision) => d.ok;
const allowed = (actor: Actor, action: Action, resource?: Resource) => ok(can(actor, action, resource, NOW));

describe("permission matrix (DESIGN §2.3)", () => {
  it("everyone can browse, subscribe and report", () => {
    for (const actor of [visitor, subscriber, reader, author, publisher, admin]) {
      expect(allowed(actor, "catalog.browse")).toBe(true);
      expect(allowed(actor, "alerts.subscribe")).toBe(true);
      expect(allowed(actor, "report.submit")).toBe(true);
    }
  });

  it("follow, shelves, preferences: not visitors", () => {
    expect(can(visitor, "reader.personalize", undefined, NOW)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    for (const actor of [subscriber, reader, author, publisher, admin]) {
      expect(allowed(actor, "reader.personalize")).toBe(true);
    }
  });

  it("rate/review: signed-in, verified email, account ≥7 days, not own books", () => {
    expect(allowed(visitor, "review.write")).toBe(false);
    expect(allowed(subscriber, "review.write")).toBe(false);
    expect(allowed(reader, "review.write", otherBook)).toBe(true);
    expect(allowed({ ...reader, createdAt: daysAgo(3) } as Actor, "review.write", otherBook)).toBe(false);
    expect(allowed({ ...reader, emailVerified: false } as Actor, "review.write", otherBook)).toBe(false);
    expect(allowed(author, "review.write", ownBook("auth1"))).toBe(false);
    expect(allowed(author, "review.write", otherBook)).toBe(true);
    expect(allowed(publisher, "review.write", ownBook("auth5"))).toBe(false);
    expect(allowed(admin, "review.write", otherBook)).toBe(true);
  });

  it("create or claim an author profile: any active account", () => {
    expect(allowed(visitor, "author_profile.create")).toBe(false);
    expect(allowed(subscriber, "author_profile.create")).toBe(false);
    expect(allowed(reader, "author_profile.create")).toBe(true);
    expect(allowed({ ...reader, state: "restricted" } as Actor, "author_profile.create")).toBe(false);
  });

  it("submit/edit books: own profiles, managed profiles, admin all", () => {
    expect(allowed(reader, "book.edit", otherBook)).toBe(false);
    expect(allowed(author, "book.edit", ownBook("auth1"))).toBe(true);
    expect(allowed(author, "book.edit", otherBook)).toBe(false);
    expect(allowed(publisher, "book.edit", ownBook("auth4"))).toBe(true);
    expect(allowed(publisher, "book.edit", ownBook("auth1"))).toBe(false);
    expect(allowed(admin, "book.edit", otherBook)).toBe(true);
    expect(allowed(author, "book.edit", { type: "book", authorIds: [] })).toBe(false);
  });

  it("buy promotions: own books T0+, managed books, admin (house); never T-1", () => {
    expect(allowed(reader, "promotion.buy", otherBook)).toBe(false);
    expect(allowed(author, "promotion.buy", ownBook("auth1"))).toBe(true);
    expect(allowed(author, "promotion.buy", otherBook)).toBe(false);
    expect(can(restrictedAuthor, "promotion.buy", ownBook("auth3"), NOW)).toEqual({
      ok: false,
      reason: "restricted",
    });
    expect(allowed(publisher, "promotion.buy", ownBook("auth4"))).toBe(true);
    expect(allowed(admin, "promotion.buy", otherBook)).toBe(true);
  });

  it("a publisher can't buy for a T-1 author it manages", () => {
    const pubWithRestricted: Actor = {
      ...reader,
      userId: "P2",
      authors: [{ authorId: "auth9", role: "editor", trust: "T-1" }],
      publishers: [{ publisherId: "pub2", role: "owner", trust: "T2", authorIds: ["auth9"] }],
    };
    expect(allowed(pubWithRestricted, "promotion.buy", ownBook("auth9"))).toBe(false);
  });

  it("guest posts: T1+ members and admin", () => {
    expect(allowed(reader, "guest_post.submit")).toBe(false);
    expect(allowed(author, "guest_post.submit")).toBe(false);
    expect(allowed(verifiedAuthor, "guest_post.submit")).toBe(true);
    expect(allowed(publisher, "guest_post.submit")).toBe(true);
    expect(allowed(admin, "guest_post.submit")).toBe(true);
  });

  it("book analytics: own and managed books, admin all", () => {
    expect(allowed(reader, "book_analytics.view", otherBook)).toBe(false);
    expect(allowed(author, "book_analytics.view", ownBook("auth1"))).toBe(true);
    expect(allowed(publisher, "book_analytics.view", ownBook("auth5"))).toBe(true);
    expect(allowed(admin, "book_analytics.view", otherBook)).toBe(true);
  });

  it("approvals, settings and refunds: admin only; settings and refunds need step-up", () => {
    for (const actor of [visitor, subscriber, reader, author, verifiedAuthor, publisher]) {
      expect(allowed(actor, "inbox.decide")).toBe(false);
      expect(allowed(actor, "schedule.manage")).toBe(false);
      expect(allowed(actor, "catalog.manage")).toBe(false);
      expect(allowed(actor, "settings.change")).toBe(false);
      expect(allowed(actor, "money.refund")).toBe(false);
    }
    expect(allowed(admin, "inbox.decide")).toBe(true);
    expect(allowed(staleAdmin, "schedule.manage")).toBe(true);
    expect(allowed(staleAdmin, "catalog.manage")).toBe(true);
    expect(allowed(admin, "settings.change")).toBe(true);
    expect(allowed(admin, "money.refund")).toBe(true);
    expect(allowed(staleAdmin, "inbox.decide")).toBe(true);
    expect(can(staleAdmin, "settings.change", undefined, NOW)).toEqual({
      ok: false,
      reason: "step_up_required",
    });
    expect(can(staleAdmin, "money.refund", undefined, NOW)).toEqual({
      ok: false,
      reason: "step_up_required",
    });
  });

  it("system and editorial actors get nothing but their own lane", () => {
    const system: Actor = { kind: "system", job: "heartbeat" };
    const editorial: Actor = { kind: "editorial", runId: "run1" };
    expect(allowed(system, "catalog.browse")).toBe(false);
    expect(allowed(editorial, "editorial.run")).toBe(true);
    expect(allowed(editorial, "inbox.decide")).toBe(false);
    expect(allowed(admin, "editorial.run")).toBe(false);
  });
});

describe("route access", () => {
  it("signed_in accepts users and admins only", () => {
    expect(checkRoute(visitor, { kind: "signed_in" }).ok).toBe(false);
    expect(checkRoute(subscriber, { kind: "signed_in" }).ok).toBe(false);
    expect(checkRoute(reader, { kind: "signed_in" }).ok).toBe(true);
  });

  it("admin routes reject everyone else", () => {
    expect(checkRoute(visitor, { kind: "admin" })).toEqual({ ok: false, reason: "unauthenticated" });
    expect(checkRoute(reader, { kind: "admin" })).toEqual({ ok: false, reason: "forbidden" });
    expect(checkRoute(admin, { kind: "admin" }).ok).toBe(true);
  });

  it("action routes use the route-level check", () => {
    expect(checkRoute(author, { kind: "action", action: "book.edit" }).ok).toBe(true);
    expect(checkRoute(reader, { kind: "action", action: "book.edit" }).ok).toBe(false);
  });
});
