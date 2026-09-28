import { ActivityError, levelUp, marksFor, setMark } from "@rlr/core/readers";
import { MARK_STATUS } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { z } from "zod";
import { fail, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

export const GET: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  const slugs = (ctx.url.searchParams.get("books") ?? "").split(",").filter(Boolean).slice(0, 60);
  if (slugs.length === 0) return Response.json({ marks: {} });
  const rows = await marksFor(getDb(), userId, slugs);
  return Response.json({ marks: Object.fromEntries(rows.map((r) => [r.slug, r.status])) });
};

const body = z.object({ book: z.string().min(1).max(200), mark: z.enum(MARK_STATUS).nullable() });

export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "marks"))) return slowDown();
  const form = !(ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const raw = form
    ? Object.fromEntries((await ctx.request.formData().catch(() => new FormData())).entries())
    : await ctx.request.json().catch(() => null);
  const parsed = body.safeParse(
    form && raw
      ? { book: (raw as Record<string, unknown>).book, mark: (raw as Record<string, unknown>).mark || null }
      : raw,
  );
  if (!parsed.success) return fail("invalid");
  try {
    const r = await setMark(getDb(), userId, parsed.data.book, parsed.data.mark);
    if (form) return ctx.redirect("/account/books?saved=1", 303);
    return Response.json({ mark: r.status, levelUp: levelUp(r.level, r.previousLevel) });
  } catch (error) {
    if (error instanceof ActivityError) return fail(error.message);
    throw error;
  }
};
