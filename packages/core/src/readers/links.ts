// Signed links in emails (DESIGN §13.3, QUIZZES §3.4): unsubscribe, one-click book choices, export
// downloads. A token names its purpose and data and is signed with LINK_SIGNING_KEYS, a JSON object
// of key id → secret. The first key signs; every key verifies, so keys rotate without breaking
// links already sent.

import { hmacSha256Hex, timingSafeEqual, toBase64Url } from "../crypto";

export type LinkKeys = { current: string; keys: Record<string, string> };

export class LinkKeyError extends Error {}

export function parseLinkKeys(json: string | undefined): LinkKeys {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "");
  } catch {
    throw new LinkKeyError("LINK_SIGNING_KEYS must be a JSON object of key id → secret");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new LinkKeyError("LINK_SIGNING_KEYS must be a JSON object");
  const keys = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      (e): e is [string, string] =>
        typeof e[1] === "string" && e[1].length >= 32 && /^[a-z0-9]{1,8}$/i.test(e[0]),
    ),
  );
  const current = Object.keys(keys)[0];
  if (!current) throw new LinkKeyError("LINK_SIGNING_KEYS needs at least one key of 32 or more characters");
  return { current, keys };
}

export type LinkPurpose = "unsub" | "mark" | "export" | "invite" | "release" | "go";

const b64 = (s: string) => toBase64Url(new TextEncoder().encode(s));
const unb64 = (s: string) => {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
};

/** `data` are short ids; `expiresAt` in ms (none for unsubscribe links: they must always work). */
export async function signLink(
  keys: LinkKeys,
  purpose: LinkPurpose,
  data: string[],
  expiresAt?: number,
): Promise<string> {
  const body = b64(JSON.stringify([keys.current, purpose, data, expiresAt ?? 0]));
  const secret = keys.keys[keys.current] ?? "";
  const sig = (await hmacSha256Hex(secret, `${purpose}.${body}`)).slice(0, 32);
  return `${body}.${sig}`;
}

export async function verifyLink(
  keys: LinkKeys,
  token: string,
  purpose: LinkPurpose,
  now = Date.now(),
): Promise<string[] | null> {
  if (token.length > 600 || !/^[A-Za-z0-9_-]+\.[0-9a-f]{32}$/.test(token)) return null;
  const [body = "", sig = ""] = token.split(".");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unb64(body));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const [kid, p, data, exp] = parsed as [unknown, unknown, unknown, unknown];
  if (p !== purpose || typeof kid !== "string" || !Array.isArray(data) || typeof exp !== "number")
    return null;
  const secret = keys.keys[kid];
  if (!secret) return null;
  const expected = (await hmacSha256Hex(secret, `${purpose}.${body}`)).slice(0, 32);
  if (!timingSafeEqual(expected, sig)) return null;
  if (exp !== 0 && exp < now) return null;
  return data.every((d) => typeof d === "string") ? (data as string[]) : null;
}
