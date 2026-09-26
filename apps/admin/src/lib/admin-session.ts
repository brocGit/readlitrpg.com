// The inner lock: a passkey-only admin session (DESIGN §15.3). The session's user must be an
// active admin whose email matches the Cloudflare Access identity on the same request.

import type { AdminAuth } from "@rlr/core/auth";
import type { Db } from "@rlr/core/db";
import type { Actor } from "@rlr/core/policy";
import { users } from "@rlr/core/schema";
import type { AccessIdentity } from "@rlr/core/security";
import type { Settings } from "@rlr/core/settings";
import { eq } from "drizzle-orm";

export interface AdminSession {
  userId: string;
  email: string;
  /** Admin sessions are created only by a passkey assertion, so this is the last proof of presence. */
  lastAuthAt: Date;
}

export async function resolveAdminSession(
  request: Request,
  deps: { auth: Pick<AdminAuth, "api">; db: Db; access: AccessIdentity; settings: () => Promise<Settings> },
): Promise<AdminSession | null> {
  const result = await deps.auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  const createdAt = new Date(result.session.createdAt);
  const epoch = (await deps.settings())["session.epoch"];
  if (epoch > 0 && createdAt.getTime() < epoch * 1000) return null;

  const [row] = await deps.db
    .select({ email: users.email, isAdmin: users.isAdmin, state: users.state })
    .from(users)
    .where(eq(users.id, result.user.id));
  if (!row?.isAdmin || row.state !== "active") return null;
  if (deps.access.kind !== "user" || deps.access.email !== row.email.toLowerCase()) return null;
  return { userId: result.user.id, email: row.email, lastAuthAt: createdAt };
}

export function adminActor(session: AdminSession | null): Actor {
  return session
    ? { kind: "admin", userId: session.userId, lastAuthAt: session.lastAuthAt }
    : { kind: "visitor" };
}
