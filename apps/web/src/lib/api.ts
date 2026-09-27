// Small helpers for the signed-in reader endpoints under /api/me (DESIGN §9.6–9.8). The route gate
// already requires a signed-in, active reader; handlers still resolve the user themselves.

import type { APIContext } from "astro";
import { withinLimit } from "./match";
import { env } from "./runtime";

export async function readerId(ctx: APIContext): Promise<string | null> {
  const actor = await ctx.locals.actor();
  return actor.kind === "user" ? actor.userId : null;
}

export const fail = (error: string, status = 400) => Response.json({ error }, { status });

export const unauthorized = () => fail("unauthenticated", 401);

/** Per-reader write limit (RL_WRITE) so a stuck island can't hammer the database. */
export async function writeAllowed(ctx: APIContext, scope: string): Promise<boolean> {
  return withinLimit(env.RL_WRITE, `me:${scope}`, ctx.request, ctx.clientAddress);
}

export const slowDown = () =>
  Response.json(
    { error: "Too many changes at once. Wait a minute and try again." },
    { status: 429, headers: { "Retry-After": "60" } },
  );

/** Form posts from account pages come back to the page they came from. */
export async function formBody(request: Request): Promise<FormData> {
  return request.formData().catch(() => new FormData());
}
