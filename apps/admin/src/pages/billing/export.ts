import { monthCsv } from "@rlr/core/billing";
import type { APIRoute } from "astro";
import { getDb } from "../../lib/runtime";

// The month's orders, refunds and credit movements as CSV for bookkeeping (DESIGN §12.8).
export const GET: APIRoute = async ({ url, locals }) => {
  if (!(await locals.admin())) return new Response(null, { status: 403 });
  const month = url.searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return new Response("Give ?month=YYYY-MM", { status: 400 });
  return new Response(await monthCsv(getDb(), month), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="readlitrpg-${month}.csv"`,
      "cache-control": "no-store",
    },
  });
};
