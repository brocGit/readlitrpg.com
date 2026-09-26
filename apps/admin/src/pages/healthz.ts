import type { APIRoute } from "astro";
import { env } from "../lib/runtime";

export const GET: APIRoute = async () => {
  try {
    await env.DB.prepare("SELECT 1").first();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
};
