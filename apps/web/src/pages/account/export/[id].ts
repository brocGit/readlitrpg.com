import { dataExports } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { readerId } from "../../../lib/api";
import { env, getDb } from "../../../lib/runtime";

// Download a data export (DESIGN §9.8): only the reader it belongs to, signed in, before it expires.
export const GET: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return ctx.redirect(`/signin?next=${encodeURIComponent(ctx.url.pathname)}`, 303);
  const [row] = await getDb()
    .select()
    .from(dataExports)
    .where(and(eq(dataExports.id, ctx.params.id ?? ""), eq(dataExports.userId, userId)));
  const now = new Date().toISOString();
  const key = row?.status === "ready" && (row.expiresAt ?? "") > now ? row.objectKey : null;
  if (!row || !key) return ctx.redirect("/account/privacy?export=expired", 303);
  const object = await env.PRIVATE.get(key);
  if (!object) return ctx.redirect("/account/privacy?export=expired", 303);
  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="readlitrpg-export-${row.createdAt.slice(0, 10)}.json"`,
      "cache-control": "private, no-store",
    },
  });
};
