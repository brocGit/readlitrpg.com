import { robotsTxt } from "@rlr/core/site";
import type { APIRoute } from "astro";
import { origin } from "../lib/site";

export const GET: APIRoute = () =>
  new Response(robotsTxt(origin()), { headers: { "content-type": "text/plain; charset=utf-8" } });
