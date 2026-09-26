// The outer lock: every request must carry a valid Cloudflare Access assertion (DESIGN §15.3).

import { type AccessIdentity, type AccessResult, verifyAccessJwt } from "@rlr/core/security";

export interface AccessEnv {
  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_DEV_EMAIL?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Local development has no Access in front, so a configured dev email stands in for the identity.
 * Both conditions must hold: ENVIRONMENT=local (set only in .dev.vars) and a localhost request.
 * The production hostname can never be localhost, so a misconfigured var alone can't open the door.
 */
export async function checkAccess(request: Request, env: AccessEnv): Promise<AccessResult> {
  const url = new URL(request.url);
  if (env.ENVIRONMENT === "local" && LOCAL_HOSTS.has(url.hostname) && env.ACCESS_DEV_EMAIL) {
    const identity: AccessIdentity = {
      kind: "user",
      email: env.ACCESS_DEV_EMAIL.toLowerCase(),
      sub: "local-dev",
    };
    return { ok: true, identity };
  }
  return verifyAccessJwt(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
}
