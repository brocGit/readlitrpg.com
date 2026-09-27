// The editorial API's two locks (DESIGN §7.1 rule 2, §15.4): a Cloudflare Access service token
// (checked as a JWT on every request, like the console) and a scoped editorial token. The token
// can only claim queue items and push proposals; it never opens the console, settings or money.

import { sha256Hex, timingSafeEqual } from "@rlr/core";
import type { AccessIdentity } from "@rlr/core/security";

export const EDITORIAL_PREFIX = "/api/editorial/";

export interface EditorialEnv {
  ENVIRONMENT: string;
  /** SHA-256 hex of the token, comma-separated during a rotation. The token itself is never stored. */
  EDITORIAL_TOKEN_HASH?: string;
  /** Access service-token client IDs allowed to reach the API. */
  EDITORIAL_ACCESS_CLIENT_IDS?: string;
}

export type EditorialAuth =
  | { ok: true; tokenSlot: number }
  | { ok: false; status: 401 | 403; reason: string };

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Production accepts only an Access *service* identity whose client ID is on the allowlist; the
 * owner's own browser session can't drive the API. Local development has no Access in front, so
 * the dev identity stands in (see checkAccess), and only the token is checked.
 */
export function checkEditorialIdentity(identity: AccessIdentity, env: EditorialEnv): EditorialAuth {
  if (env.ENVIRONMENT === "local") return { ok: true, tokenSlot: -1 };
  if (identity.kind !== "service") return { ok: false, status: 403, reason: "service_token_required" };
  // The wrangler.jsonc placeholder never matches: the API stays shut until setup names the token.
  const allowed = list(env.EDITORIAL_ACCESS_CLIENT_IDS).filter((id) => id !== "set-at-setup");
  if (!allowed.includes(identity.clientId))
    return { ok: false, status: 403, reason: "service_token_not_allowed" };
  return { ok: true, tokenSlot: -1 };
}

export async function checkEditorialToken(request: Request, env: EditorialEnv): Promise<EditorialAuth> {
  const hashes = list(env.EDITORIAL_TOKEN_HASH).filter((h) => /^[0-9a-f]{64}$/.test(h));
  if (hashes.length === 0) return { ok: false, status: 403, reason: "editorial_api_not_configured" };
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,200})$/.exec(header);
  if (!match?.[1]) return { ok: false, status: 401, reason: "missing_token" };
  const digest = await sha256Hex(match[1]);
  // Compare against every slot so timing doesn't reveal which one matched.
  let slot = -1;
  hashes.forEach((h, i) => {
    if (timingSafeEqual(h, digest) && slot < 0) slot = i;
  });
  return slot >= 0 ? { ok: true, tokenSlot: slot } : { ok: false, status: 401, reason: "bad_token" };
}
