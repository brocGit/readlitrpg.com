import { ActivityError, followState, setConsent, setFollow } from "@rlr/core/readers";
import { FOLLOW_NOTIFY } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { z } from "zod";
import { fail, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

const TYPES = ["author", "series", "narrator", "tag", "book"] as const;
const slug = z.string().min(1).max(200);

export const GET: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  const type = z.enum(TYPES).safeParse(ctx.url.searchParams.get("type"));
  const s = slug.safeParse(ctx.url.searchParams.get("slug"));
  if (!type.success || !s.success) return fail("invalid");
  return Response.json({ notify: await followState(getDb(), userId, type.data, s.data) });
};

const body = z.object({ type: z.enum(TYPES), slug, notify: z.enum(FOLLOW_NOTIFY).nullable() });

export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "follow"))) return slowDown();
  const form = !(ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const raw = form
    ? Object.fromEntries((await ctx.request.formData().catch(() => new FormData())).entries())
    : await ctx.request.json().catch(() => null);
  const parsed = body.safeParse(
    form && raw
      ? {
          ...raw,
          notify:
            (raw as Record<string, unknown>).notify === "unfollow"
              ? null
              : (raw as Record<string, unknown>).notify,
        }
      : raw,
  );
  if (!parsed.success) return fail("invalid");
  try {
    const db = getDb();
    const on = await setFollow(db, userId, parsed.data.type, parsed.data.slug, parsed.data.notify);
    // Asking for release-day emails is the opt-in to that list (the reader is signed in and verified).
    if (parsed.data.notify === "instant") await setConsent(db, userId, "release_alerts", true, "follow");
    if (form) return ctx.redirect("/account/follows?saved=1", 303);
    return Response.json({ notify: on ? parsed.data.notify : null });
  } catch (error) {
    if (error instanceof ActivityError) return fail(error.message);
    throw error;
  }
};
