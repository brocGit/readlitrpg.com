import type { APIRoute } from "astro";
import { env } from "../lib/runtime";

// Liveness plus a one-row database read. Reveals nothing beyond "up" or "down".
export const GET: APIRoute = async () => {
  try {
    await env.DB.prepare("SELECT 1").first();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
