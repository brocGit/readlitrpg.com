import type { APIRoute } from "astro";
import { env } from "../../lib/runtime";

// In production media.readlitrpg.com serves the MEDIA bucket directly (cookie-less, DESIGN §4.5).
// This route serves the same objects wherever that domain isn't in front, e.g. local dev.
const KEY = /^(covers|og)\/[a-z0-9_-]+(\/[a-z0-9_.-]+)*\.(webp|png)$/i;

export const GET: APIRoute = async ({ params }) => {
  const key = params.key ?? "";
  if (!KEY.test(key)) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
};
