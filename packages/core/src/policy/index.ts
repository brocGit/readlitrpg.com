// One place decides who may do what (DESIGN §2.3, §15.4). Every route declares an access rule, and
// handlers that touch owned resources call `can()` with the resource so ownership is checked too.

export type TrustLevel = "T-1" | "T0" | "T1" | "T2";

export interface AuthorMembership {
  authorId: string;
  role: "owner" | "editor";
  trust: TrustLevel;
}

export interface PublisherMembership {
  publisherId: string;
  role: "owner" | "editor";
  trust: TrustLevel;
  /** Author profiles this publisher manages. */
  authorIds: string[];
}

export type Actor =
  | { kind: "visitor" }
  | { kind: "subscriber"; userId: string }
  | {
      kind: "user";
      userId: string;
      state: "active" | "restricted";
      emailVerified: boolean;
      createdAt: Date;
      authors: AuthorMembership[];
      publishers: PublisherMembership[];
    }
  | {
      kind: "admin";
      userId: string;
      /** When the admin last proved presence with a passkey. Money and settings need it fresh. */
      lastAuthAt: Date;
    }
  | { kind: "system"; job: string }
  | { kind: "editorial"; runId: string };

/** Resources that carry ownership. Loaders attach the owning author IDs. */
export type Resource =
  | { type: "author"; authorId: string }
  | { type: "book"; authorIds: string[] }
  | { type: "any" };

export const ACTIONS = [
  "catalog.browse",
  "alerts.subscribe",
  "reader.personalize",
  "report.submit",
  "review.write",
  "author_profile.create",
  "book.edit",
  "promotion.buy",
  "guest_post.submit",
  "book_analytics.view",
  "inbox.decide",
  "settings.change",
  "money.refund",
  "editorial.run",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Admin actions that need a passkey assertion within this many seconds (DESIGN §15.3). */
export const STEP_UP_ACTIONS: ReadonlySet<Action> = new Set(["settings.change", "money.refund"]);
export const STEP_UP_MAX_AGE_SECONDS = 15 * 60;
export const REVIEW_MIN_ACCOUNT_DAYS = 7;

export type Decision =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "forbidden" | "step_up_required" | "restricted" };

const ALLOW: Decision = { ok: true };
const deny = (reason: Exclude<Decision, { ok: true }>["reason"]): Decision => ({ ok: false, reason });

const TRUST_RANK: Record<TrustLevel, number> = { "T-1": -1, T0: 0, T1: 1, T2: 2 };

export function can(
  actor: Actor,
  action: Action,
  resource: Resource = { type: "any" },
  now = new Date(),
): Decision {
  switch (actor.kind) {
    case "admin":
      if (action === "editorial.run") return deny("forbidden");
      if (STEP_UP_ACTIONS.has(action)) {
        const ageSeconds = (now.getTime() - actor.lastAuthAt.getTime()) / 1000;
        if (ageSeconds > STEP_UP_MAX_AGE_SECONDS) return deny("step_up_required");
      }
      return ALLOW;

    case "system":
      return deny("forbidden");

    case "editorial":
      // Editorial runs only push proposals; the policy engine decides what publishes.
      return action === "editorial.run" ? ALLOW : deny("forbidden");

    case "visitor":
      if (action === "catalog.browse" || action === "alerts.subscribe" || action === "report.submit") {
        return ALLOW;
      }
      return deny("unauthenticated");

    case "subscriber":
      // "limited (via email link)": the link grants follow/preference edits for that subscriber only.
      if (
        action === "catalog.browse" ||
        action === "alerts.subscribe" ||
        action === "report.submit" ||
        action === "reader.personalize"
      ) {
        return ALLOW;
      }
      return deny("unauthenticated");

    case "user":
      return userCan(actor, action, resource, now);
  }
}

function userCan(
  actor: Extract<Actor, { kind: "user" }>,
  action: Action,
  resource: Resource,
  now: Date,
): Decision {
  switch (action) {
    case "catalog.browse":
    case "alerts.subscribe":
    case "report.submit":
    case "reader.personalize":
      return ALLOW;
    case "author_profile.create":
      return actor.state === "restricted" ? deny("restricted") : ALLOW;
    case "review.write": {
      if (!actor.emailVerified) return deny("forbidden");
      const ageDays = (now.getTime() - actor.createdAt.getTime()) / 86_400_000;
      if (ageDays < REVIEW_MIN_ACCOUNT_DAYS) return deny("forbidden");
      // Members may not review their own (or their publisher's) books.
      if (resource.type === "book" && managesAny(actor, resource.authorIds)) return deny("forbidden");
      return ALLOW;
    }
    case "book.edit":
    case "book_analytics.view":
      return ownsResource(actor, resource) ? ALLOW : deny("forbidden");
    case "promotion.buy": {
      if (actor.state === "restricted") return deny("restricted");
      if (!ownsResource(actor, resource)) return deny("forbidden");
      // T-1 profiles can't buy ads (DESIGN §2.2), even through a publisher that manages them.
      const levels = relevantTrust(actor, resource);
      const allowed = resource.type === "any" ? levels.some((l) => l !== "T-1") : !levels.includes("T-1");
      return allowed ? ALLOW : deny("restricted");
    }
    case "guest_post.submit": {
      const levels = [...actor.authors, ...actor.publishers].map((m) => TRUST_RANK[m.trust]);
      return levels.some((l) => l >= TRUST_RANK.T1) ? ALLOW : deny("forbidden");
    }
    case "inbox.decide":
    case "settings.change":
    case "money.refund":
    case "editorial.run":
      return deny("forbidden");
  }
}

/** Author IDs this user can act for: their own profiles plus every profile their publishers manage. */
export function managedAuthorIds(actor: Extract<Actor, { kind: "user" }>): Set<string> {
  const ids = new Set(actor.authors.map((a) => a.authorId));
  for (const p of actor.publishers) for (const id of p.authorIds) ids.add(id);
  return ids;
}

function managesAny(actor: Extract<Actor, { kind: "user" }>, authorIds: string[]): boolean {
  const managed = managedAuthorIds(actor);
  return authorIds.some((id) => managed.has(id));
}

function ownsResource(actor: Extract<Actor, { kind: "user" }>, resource: Resource): boolean {
  switch (resource.type) {
    case "author":
      return managedAuthorIds(actor).has(resource.authorId);
    case "book":
      return resource.authorIds.length > 0 && managesAny(actor, resource.authorIds);
    case "any":
      // Route-level check: the handler must check the specific resource again.
      return actor.authors.length > 0 || actor.publishers.length > 0;
  }
}

/** Trust levels of this user's memberships that manage the resource. */
function relevantTrust(actor: Extract<Actor, { kind: "user" }>, resource: Resource): TrustLevel[] {
  const ids =
    resource.type === "author" ? [resource.authorId] : resource.type === "book" ? resource.authorIds : null;
  const levels: TrustLevel[] = [];
  for (const m of actor.authors) {
    if (!ids || ids.includes(m.authorId)) levels.push(m.trust);
  }
  for (const p of actor.publishers) {
    if (!ids || p.authorIds.some((id) => ids.includes(id))) levels.push(p.trust);
  }
  return levels;
}

// ---------------------------------------------------------------------------------------------
// Route access. Every page and endpoint in `web` and `admin` has an entry in its app's route
// registry. A test fails the build if a route file has no entry (DESIGN §15.4).

export type RouteAccess =
  | { kind: "public" }
  | { kind: "signed_in" }
  | { kind: "action"; action: Action }
  | { kind: "admin" };

export const PUBLIC: RouteAccess = { kind: "public" };
export const SIGNED_IN: RouteAccess = { kind: "signed_in" };
export const ADMIN: RouteAccess = { kind: "admin" };
export const requires = (action: Action): RouteAccess => ({ kind: "action", action });

export type RouteRegistry = Record<string, RouteAccess>;

/** Route-level gate. Resource-level checks happen in the handler with the loaded resource. */
export function checkRoute(actor: Actor, access: RouteAccess, now = new Date()): Decision {
  switch (access.kind) {
    case "public":
      return ALLOW;
    case "signed_in":
      return actor.kind === "user" || actor.kind === "admin" ? ALLOW : deny("unauthenticated");
    case "admin":
      return actor.kind === "admin"
        ? ALLOW
        : deny(actor.kind === "visitor" ? "unauthenticated" : "forbidden");
    case "action":
      return can(actor, access.action, { type: "any" }, now);
  }
}
