import { attachTakes } from "@rlr/core/quiz";
import { quizTakes } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { fail, formBody, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

// Quiz takes (QUIZZES §4.3): attach this browser's anonymous takes once signed in (JSON), or delete
// one from the privacy page (form).
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "takes"))) return slowDown();
  const db = getDb();
  if ((ctx.request.headers.get("content-type") ?? "").includes("application/json")) {
    const body = z
      .object({ attach: z.array(z.string().max(40)).max(50) })
      .safeParse(await ctx.request.json().catch(() => null));
    if (!body.success) return fail("invalid");
    return Response.json({ attached: await attachTakes(db, userId, body.data.attach) });
  }
  const id = String((await formBody(ctx.request)).get("delete") ?? "");
  await db.delete(quizTakes).where(and(eq(quizTakes.id, id), eq(quizTakes.userId, userId)));
  return ctx.redirect("/account/privacy?take=deleted", 303);
};
