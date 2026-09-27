import type { APIRoute } from "astro";
import { acceptStripeWebhook } from "../../../lib/billing";

// Stripe webhooks (DESIGN §12.3). Stripe posts JSON without an Origin header, so this route is
// exempt from the form origin check; every request is authenticated by its signature instead,
// checked against the raw body before anything is parsed or stored.
export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  if (body.length > 256_000) return new Response("Too large", { status: 413 });
  return acceptStripeWebhook(body, request.headers.get("stripe-signature"));
};
