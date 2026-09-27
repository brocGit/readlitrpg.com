// Stripe webhooks (DESIGN §12.3): verify the signature on the raw body, then record the event once.
// Processing happens in the jobs Worker, which re-reads the object from Stripe before acting, so
// the event body is only ever a pointer and a replayed or reordered event can't do harm.

import { hmacSha256Hex, timingSafeEqual } from "../crypto";
import type { Db } from "../db";
import { stripeEvents } from "../db/schema";
import type { StripeEvent } from "./stripe";

/** Stripe's default tolerance: a signature older than this is a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The Stripe-Signature header for a payload (Stripe's scheme; used by the fake and in tests). */
export async function signStripePayload(body: string, secret: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

/**
 * The event, if the header carries a valid v1 signature from one of `secrets` (two during a
 * rotation, comma-separated) made within the tolerance. Null otherwise.
 */
export async function verifyStripeWebhook(
  body: string,
  header: string | null,
  secrets: string,
  now = new Date(),
): Promise<StripeEvent | null> {
  if (!header || !secrets) return null;
  let t = 0;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") t = Number(v);
    else if (k?.trim() === "v1" && v) sigs.push(v.trim());
  }
  if (!Number.isFinite(t) || t <= 0 || !sigs.length) return null;
  if (Math.abs(now.getTime() / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) return null;
  let ok = false;
  for (const secret of secrets
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const expected = await hmacSha256Hex(secret, `${t}.${body}`);
    if (sigs.some((s) => timingSafeEqual(s, expected))) ok = true;
  }
  if (!ok) return null;
  try {
    const event = JSON.parse(body) as StripeEvent;
    if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) return null;
    return event;
  } catch {
    return null;
  }
}

/** The events we act on (§12.3). Anything else is recorded as ignored. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

/** Record an event once. Returns true when it's new and needs processing. */
export async function recordStripeEvent(db: Db, event: StripeEvent, now = new Date()): Promise<boolean> {
  const handled = HANDLED_EVENTS.has(event.type);
  const rows = await db
    .insert(stripeEvents)
    .values({
      eventId: event.id.slice(0, 100),
      type: event.type.slice(0, 80),
      objectId: String(event.data.object.id ?? "").slice(0, 100) || null,
      livemode: Boolean(event.livemode),
      status: handled ? "queued" : "ignored",
      receivedAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.eventId });
  return rows.length === 1 && handled;
}
