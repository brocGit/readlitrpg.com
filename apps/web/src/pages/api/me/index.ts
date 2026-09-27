import { maskEmail } from "@rlr/core";
import type { APIRoute } from "astro";

// For islands on cached pages: who is signed in, if anyone. Never cached.
export const GET: APIRoute = async ({ locals }) => {
  const session = await locals.session();
  return Response.json(session ? { signedIn: true, email: maskEmail(session.email) } : { signedIn: false });
};
