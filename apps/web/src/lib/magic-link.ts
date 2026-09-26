// Sign-in links (DESIGN §15.3). Better Auth builds a URL that signs in on the first GET. Email
// scanners follow links, so we send people to a confirmation page instead, and only the button
// there calls the verify endpoint.

import { maskEmail } from "@rlr/core";
import { safeRedirectPath } from "@rlr/core/security";

export interface MagicLinkEnv {
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  EMAIL_DELIVERY: string;
  Q_EMAIL: Queue;
}

/** Turn Better Auth's verify URL into our confirmation page URL. */
export function toConfirmUrl(verifyUrl: string, email: string, origin: string): string {
  const source = new URL(verifyUrl);
  const token = source.searchParams.get("token");
  if (!token) throw new Error("magic link URL has no token");
  const target = new URL("/signin/confirm", origin);
  target.searchParams.set("token", token);
  target.searchParams.set("next", safeRedirectPath(source.searchParams.get("callbackURL"), "/account"));
  const newUser = source.searchParams.get("newUserCallbackURL");
  if (newUser) target.searchParams.set("new", safeRedirectPath(newUser, "/account"));
  target.searchParams.set("e", maskEmail(email));
  return target.toString();
}

export async function deliverMagicLink(
  env: MagicLinkEnv,
  message: { email: string; url: string },
): Promise<void> {
  const url = toConfirmUrl(message.url, message.email, env.PUBLIC_ORIGIN);
  if (env.EMAIL_DELIVERY === "console") {
    if (env.ENVIRONMENT !== "local") throw new Error("console email delivery is for local development only");
    console.log(`\n[dev] Sign-in link for ${message.email}:\n${url}\n`);
    return;
  }
  await env.Q_EMAIL.send({
    kind: "magic_link",
    to: message.email,
    url,
    requestedAt: new Date().toISOString(),
  });
}
