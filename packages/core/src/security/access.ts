// Cloudflare Access JWT verification (DESIGN §15.3). The admin Worker checks the
// `Cf-Access-Jwt-Assertion` header on every request: signature against the team's keys, issuer,
// audience and expiry. A route that Access misses still fails closed here.

import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export interface AccessConfig {
  /** e.g. "https://readlitrpg.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** Injected in tests. Defaults to the team's published certs. */
  keys?: JWTVerifyGetKey;
}

export type AccessIdentity =
  | { kind: "user"; email: string; sub: string }
  | { kind: "service"; clientId: string; sub: string };

export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

export const ACCESS_HEADER = "cf-access-jwt-assertion";

const keySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    // jose caches the key set per isolate and refetches when it sees an unknown `kid`.
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain), { cooldownDuration: 30_000 });
    keySets.set(teamDomain, keys);
  }
  return keys;
}

export function normalizeTeamDomain(value: string): string {
  const withScheme = /^https:\/\//.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) {
    throw new Error("ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com");
  }
  return url.origin;
}

export async function verifyAccessJwt(request: Request, config: AccessConfig): Promise<AccessResult> {
  const token = request.headers.get(ACCESS_HEADER);
  if (!token) return { ok: false, reason: "missing_assertion" };
  if (!config.audience) return { ok: false, reason: "misconfigured" };
  let teamDomain: string;
  try {
    teamDomain = normalizeTeamDomain(config.teamDomain);
  } catch {
    return { ok: false, reason: "misconfigured" };
  }
  try {
    const { payload } = await jwtVerify(token, config.keys ?? remoteKeys(teamDomain), {
      issuer: teamDomain,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: ["exp", "iat"],
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (typeof payload.email === "string" && payload.email) {
      return { ok: true, identity: { kind: "user", email: payload.email.toLowerCase(), sub } };
    }
    // Service tokens carry the client ID in `common_name` and no email.
    if (typeof payload.common_name === "string" && payload.common_name) {
      return { ok: true, identity: { kind: "service", clientId: payload.common_name, sub } };
    }
    return { ok: false, reason: "no_identity" };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "invalid";
    return { ok: false, reason: code };
  }
}
