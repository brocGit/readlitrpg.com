// Who is asking. Public pages never call this, so their HTML stays identical for everyone and can
// be edge-cached; personal bits load in islands from /api/me (DESIGN §4.6).

import type { WebAuth } from "@rlr/core/auth";
import type { Db } from "@rlr/core/db";
import type { Actor } from "@rlr/core/policy";
import { users } from "@rlr/core/schema";
import type { Settings } from "@rlr/core/settings";
import { eq } from "drizzle-orm";

export interface SessionInfo {
  userId: string;
  email: string;
  sessionCreatedAt: Date;
}

export const VISITOR: Actor = { kind: "visitor" };

export async function resolveSession(
  request: Request,
  deps: { auth: WebAuth; settings: () => Promise<Settings> },
): Promise<SessionInfo | null> {
  const result = await deps.auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  const createdAt = new Date(result.session.createdAt);
  // `session.epoch` (Unix seconds) signs everyone out during an incident (DESIGN §15.3).
  const epoch = (await deps.settings())["session.epoch"];
  if (epoch > 0 && createdAt.getTime() < epoch * 1000) return null;
  return { userId: result.user.id, email: result.user.email, sessionCreatedAt: createdAt };
}

export async function resolveActor(session: SessionInfo | null, db: Db): Promise<Actor> {
  if (!session) return VISITOR;
  const [row] = await db
    .select({ state: users.state, emailVerified: users.emailVerified, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, session.userId));
  if (!row || (row.state !== "active" && row.state !== "restricted")) return VISITOR;
  return {
    kind: "user",
    userId: session.userId,
    state: row.state,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    // Author and publisher memberships arrive with the author features (M6).
    authors: [],
    publishers: [],
  };
}
