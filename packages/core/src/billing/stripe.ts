// A small Stripe client (DESIGN §12): the few REST calls we make, form-encoded, through safeFetch
// to api.stripe.com only, with a pinned API version and an idempotency key on every write. No SDK:
// one dependency less, and every outbound request goes through the same allowlist as the rest.
// Locally, a fake with the same interface (./fake.ts) stands in, so the whole purchase flow runs
// in the browser tests without a Stripe account.

import { safeFetch } from "../net/safe-fetch";

/** Response shapes follow this version whatever the account's default is. */
export const STRIPE_API_VERSION = "2024-06-20";
const API = "https://api.stripe.com/v1";

export interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  mode: "payment" | "subscription";
  customer: string | null;
  payment_intent: string | null;
  subscription: string | null;
  invoice: string | null;
  amount_total: number | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  created: number;
  expires_at: number;
}

export interface StripeSubscription {
  id: string;
  object: "subscription";
  status: string;
  customer: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  items: { data: { price: { id: string; recurring: { interval: string } | null } }[] };
}

export interface StripeInvoice {
  id: string;
  object: "invoice";
  customer: string;
  subscription: string | null;
  status: string;
  amount_paid: number;
  payment_intent: string | null;
  billing_reason: string | null;
}

export interface StripeRefund {
  id: string;
  object: "refund";
  status: string;
  amount: number;
  payment_intent: string | null;
}

export interface StripeCharge {
  id: string;
  object: "charge";
  payment_intent: string | null;
  amount: number;
  amount_refunded: number;
}

export interface StripeDispute {
  id: string;
  object: "dispute";
  charge: string;
  payment_intent: string | null;
  status: string;
  amount: number;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: { id: string; object: string } & Record<string, unknown> };
}

export type LineItem = { name: string; amountCents: number } | { price: string };

export interface CheckoutParams {
  mode: "payment" | "subscription";
  customer: string;
  lineItems: LineItem[];
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds; Stripe accepts 30 minutes to 24 hours ahead. */
  expiresAt?: number;
  couponId?: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
  automaticTax?: boolean;
}

export interface StripeApi {
  /** "fake" only in local development. */
  readonly mode: "live" | "test" | "fake";
  createCustomer(
    p: { email: string; name?: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  createCheckoutSession(p: CheckoutParams, idempotencyKey: string): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  expireCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  listCheckoutSessions(p: {
    createdGte: number;
    startingAfter?: string;
  }): Promise<{ data: StripeCheckoutSession[]; has_more: boolean }>;
  createCoupon(p: { amountOffCents: number; name: string }, idempotencyKey: string): Promise<{ id: string }>;
  createRefund(
    p: { paymentIntent: string; amountCents: number; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeRefund>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  retrieveInvoice(id: string): Promise<StripeInvoice>;
  retrieveCharge(id: string): Promise<StripeCharge>;
  retrieveDispute(id: string): Promise<StripeDispute>;
  createPortalSession(p: { customer: string; returnUrl: string }): Promise<{ url: string }>;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** Stripe's form encoding: nested objects and arrays as `a[b][0][c]=…`. */
export function formEncode(value: unknown, prefix = "", out = new URLSearchParams()): URLSearchParams {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      formEncode(v, `${prefix}[${i}]`, out);
    });
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
  } else out.append(prefix, String(value));
  return out;
}

/** Our checkout params as Stripe's `checkout.sessions.create` body. */
export function checkoutBody(p: CheckoutParams): Record<string, unknown> {
  return {
    mode: p.mode,
    customer: p.customer,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    expires_at: p.expiresAt,
    client_reference_id: p.clientReferenceId,
    metadata: p.metadata,
    line_items: p.lineItems.map((li) =>
      "price" in li
        ? { price: li.price, quantity: 1 }
        : {
            quantity: 1,
            price_data: { currency: "usd", unit_amount: li.amountCents, product_data: { name: li.name } },
          },
    ),
    discounts: p.couponId ? [{ coupon: p.couponId }] : undefined,
    automatic_tax: p.automaticTax ? { enabled: true } : undefined,
    // A receipt the advertiser can download, and the order id on the payment for reconciliation.
    ...(p.mode === "payment"
      ? { invoice_creation: { enabled: true }, payment_intent_data: { metadata: p.metadata } }
      : { subscription_data: { metadata: p.metadata } }),
  };
}

export function httpStripe(secretKey: string, fetchImpl?: typeof fetch): StripeApi {
  if (!/^(sk|rk)_(live|test)_/.test(secretKey)) throw new Error("STRIPE_SECRET_KEY doesn't look like a key");
  const mode = secretKey.includes("_live_") ? "live" : "test";
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, idem?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      "stripe-version": STRIPE_API_VERSION,
    };
    let url = `${API}${path}`;
    let payload: string | undefined;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (idem) headers["idempotency-key"] = idem;
      payload = formEncode(body ?? {}).toString();
    } else if (body) url += `?${formEncode(body).toString()}`;
    const res = await safeFetch(url, {
      allowHosts: ["api.stripe.com"],
      method,
      body: payload,
      headers,
      fetch: fetchImpl,
      timeoutMs: 15_000,
      maxBytes: 2_000_000,
    });
    const json = JSON.parse(res.text || "{}") as T & { error?: { code?: string; message?: string } };
    if (res.status >= 400) {
      // Stripe's messages never contain the key; keep them short anyway.
      throw new StripeError(
        res.status,
        json.error?.code ?? null,
        (json.error?.message ?? `HTTP ${res.status}`).slice(0, 300),
      );
    }
    return json;
  }
  return {
    mode,
    createCustomer: (p, idem) => call("POST", "/customers", p, idem),
    createCheckoutSession: (p, idem) => call("POST", "/checkout/sessions", checkoutBody(p), idem),
    retrieveCheckoutSession: (id) => call("GET", `/checkout/sessions/${encodeURIComponent(id)}`),
    expireCheckoutSession: (id) => call("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`),
    listCheckoutSessions: (p) =>
      call("GET", "/checkout/sessions", {
        created: { gte: p.createdGte },
        limit: 100,
        starting_after: p.startingAfter,
      }),
    createCoupon: (p, idem) =>
      call(
        "POST",
        "/coupons",
        { amount_off: p.amountOffCents, currency: "usd", duration: "once", max_redemptions: 1, name: p.name },
        idem,
      ),
    createRefund: (p, idem) =>
      call(
        "POST",
        "/refunds",
        { payment_intent: p.paymentIntent, amount: p.amountCents, metadata: p.metadata },
        idem,
      ),
    retrieveSubscription: (id) => call("GET", `/subscriptions/${encodeURIComponent(id)}`),
    retrieveInvoice: (id) => call("GET", `/invoices/${encodeURIComponent(id)}`),
    retrieveCharge: (id) => call("GET", `/charges/${encodeURIComponent(id)}`),
    retrieveDispute: (id) => call("GET", `/disputes/${encodeURIComponent(id)}`),
    createPortalSession: (p) =>
      call("POST", "/billing_portal/sessions", { customer: p.customer, return_url: p.returnUrl }),
  };
}
