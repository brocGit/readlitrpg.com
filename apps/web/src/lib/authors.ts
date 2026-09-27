// The author dashboard's access checks (DESIGN §2.3, §15.4): every page loads the profile or book it
// acts on and asks the policy module, rather than trusting an id in the URL.

import { bookAuthorIds } from "@rlr/core/authors";
import { type Actor, type AuthorMembership, can, managedAuthorIds } from "@rlr/core/policy";
import { getDb } from "./runtime";

type UserActor = Extract<Actor, { kind: "user" }>;

export interface MemberAccess {
  actor: UserActor;
  membership: AuthorMembership;
}

/** The signed-in member's access to one profile, or null. `owner` demands the owner role. */
export async function profileAccess(
  locals: App.Locals,
  authorId: string,
  role?: "owner",
): Promise<MemberAccess | null> {
  const actor = await locals.actor();
  if (actor.kind !== "user") return null;
  if (!can(actor, "book.edit", { type: "author", authorId }).ok) return null;
  const membership = actor.authors.find((m) => m.authorId === authorId);
  if (!membership || (role === "owner" && membership.role !== "owner")) return null;
  return { actor, membership };
}

/** Access to a book through one of the member's profiles credited on it. */
export async function bookAccess(locals: App.Locals, bookId: string): Promise<MemberAccess | null> {
  const actor = await locals.actor();
  if (actor.kind !== "user") return null;
  const authorIds = await bookAuthorIds(getDb(), bookId);
  if (!can(actor, "book.edit", { type: "book", authorIds }).ok) return null;
  const managed = managedAuthorIds(actor);
  const membership = actor.authors.find((m) => authorIds.includes(m.authorId) && managed.has(m.authorId));
  return membership ? { actor, membership } : null;
}

export const TRUST_LABEL: Record<string, string> = {
  "T-1": "Restricted",
  T0: "Unverified",
  T1: "Verified",
  T2: "Trusted",
};

export interface InviteEnv {
  ENVIRONMENT: string;
  EMAIL_DELIVERY: string;
  Q_EMAIL: Queue;
}

/** Team invites go by email; locally they print to the dev console like sign-in links. */
export async function deliverInvite(
  env: InviteEnv,
  invite: { to: string; url: string; authorName: string; role: "owner" | "editor" },
): Promise<void> {
  if (env.EMAIL_DELIVERY === "console") {
    if (env.ENVIRONMENT !== "local") throw new Error("console email delivery is for local development only");
    console.log(`\n[dev] Team invite for ${invite.authorName}:\n${invite.url}\n`);
    return;
  }
  await env.Q_EMAIL.send({ kind: "author_invite", ...invite, requestedAt: new Date().toISOString() });
}
