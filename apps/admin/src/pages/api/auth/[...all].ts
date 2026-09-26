import type { APIRoute } from "astro";
import { getAuth } from "../../../lib/runtime";

export const ALL: APIRoute = async ({ request }) => getAuth().handler(request);
