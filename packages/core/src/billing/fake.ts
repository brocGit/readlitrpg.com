// A local stand-in for Stripe (development and the browser tests only; refused in production by
// `stripeFor`). It keeps its objects in the CONFIG KV namespace, which all three Workers share, so
// a session the web Worker creates can be "paid" on a local checkout page and read back by the jobs
// Worker. Paying produces the same events Stripe would send, signed and delivered to our own
// webhook handler, so the real verification and processing code runs end to end.

import type {
  CheckoutParams,
  StripeApi,
  StripeCharge,
  StripeCheckoutSession,
  StripeDispute,
  StripeEvent,
  StripeInvoice,
  StripeRefund,
  StripeSubscription,
} from "./stripe";
import { StripeError } from "./stripe";

type Obj = { id: string; object: string } & Record<string, unknown>;

const KEY = "fakestripe";
let counter = 0;
const fakeId = (prefix: string) =>
  `${prefix}_fake_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const unix = (d = new Date()) => Math.floor(d.getTime() / 1000);

export interface FakeStripe extends StripeApi {
  /** "Pay" on the local checkout page: completes the session and returns the events Stripe would send. */
  completeCheckout(sessionId: string): Promise<StripeEvent[]>;
  /** "Cancel" on the local portal page. */
  cancelSubscription(subscriptionId: string, atPeriodEnd: boolean): Promise<StripeEvent[]>;
  /** A chargeback, for testing the dispute path locally. */
  openDispute(paymentIntent: string): Promise<StripeEvent[]>;
  /** The customer's subscriptions, for the local portal page. */
  subscriptionsFor(customer: string): Promise<StripeSubscription[]>;
}

export function fakeStripe(kv: KVNamespace, origin: string): FakeStripe {
  const get = async <T>(id: string): Promise<T> => {
    const raw = await kv.get(`${KEY}:obj:${id}`);
    if (!raw) throw new StripeError(404, "resource_missing", `No such object: ${id}`);
    return JSON.parse(raw) as T;
  };
  const put = async (o: Obj) => {
    await kv.put(`${KEY}:obj:${o.id}`, JSON.stringify(o));
    return o;
  };
  const listAdd = async (list: string, id: string) => {
    const ids = JSON.parse((await kv.get(`${KEY}:list:${list}`)) ?? "[]") as string[];
    ids.push(id);
    await kv.put(`${KEY}:list:${list}`, JSON.stringify(ids.slice(-500)));
  };
  const listGet = async (list: string) =>
    JSON.parse((await kv.get(`${KEY}:list:${list}`)) ?? "[]") as string[];
  /** Stripe's idempotency: the same key returns the first result. */
  const idem = async <T extends Obj>(key: string, make: () => Promise<T>): Promise<T> => {
    const seen = await kv.get(`${KEY}:idem:${key}`);
    if (seen) return get<T>(seen);
    const o = await make();
    await kv.put(`${KEY}:idem:${key}`, o.id);
    return o;
  };
  const event = (type: string, object: Obj): StripeEvent => ({
    id: fakeId("evt"),
    type,
    created: unix(),
    livemode: false,
    data: { object },
  });

  const api: FakeStripe = {
    mode: "fake",
    createCustomer: (p, key) =>
      idem(key, async () =>
        put({ id: fakeId("cus"), object: "customer", email: p.email, metadata: p.metadata }),
      ),
    createCheckoutSession: (p: CheckoutParams, key) =>
      idem(key, async () => {
        const id = fakeId("cs");
        const amount = p.lineItems.reduce((n, li) => n + ("price" in li ? 0 : li.amountCents), 0);
        const coupon = p.couponId ? await get<{ amount_off: number }>(p.couponId) : null;
        const session: StripeCheckoutSession & Obj = {
          id,
          object: "checkout.session",
          url: `${origin}/dev/stripe/checkout/${id}`,
          status: "open",
          payment_status: "unpaid",
          mode: p.mode,
          customer: p.customer,
          payment_intent: null,
          subscription: null,
          invoice: null,
          amount_total:
            p.mode === "subscription"
              ? Number(p.metadata.amount_cents ?? 0)
              : Math.max(0, amount - (coupon?.amount_off ?? 0)),
          client_reference_id: p.clientReferenceId,
          metadata: p.metadata,
          created: unix(),
          expires_at: p.expiresAt ?? unix() + 86_400,
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
          line_items: p.lineItems,
        };
        await listAdd("sessions", id);
        return put(session) as Promise<StripeCheckoutSession & Obj>;
      }),
    retrieveCheckoutSession: (id) => get(id),
    async expireCheckoutSession(id) {
      const s = await get<StripeCheckoutSession & Obj>(id);
      if (s.status !== "open") throw new StripeError(400, "checkout_session_not_open", "Session isn't open");
      s.status = "expired";
      await put(s);
      return s;
    },
    async listCheckoutSessions(p) {
      const all = await Promise.all((await listGet("sessions")).map((id) => get<StripeCheckoutSession>(id)));
      return { data: all.filter((s) => s.created >= p.createdGte).reverse(), has_more: false };
    },
    createCoupon: (p, key) =>
      idem(key, async () => put({ id: fakeId("coupon"), object: "coupon", amount_off: p.amountOffCents })),
    createRefund: (p, key) =>
      idem(key, async () => {
        const refund: StripeRefund & Obj = {
          id: fakeId("re"),
          object: "refund",
          status: "succeeded",
          amount: p.amountCents,
          payment_intent: p.paymentIntent,
        };
        const chargeId = await kv.get(`${KEY}:charge_for:${p.paymentIntent}`);
        if (chargeId) {
          const ch = await get<StripeCharge & Obj>(chargeId);
          ch.amount_refunded = Math.min(ch.amount, ch.amount_refunded + p.amountCents);
          await put(ch);
        }
        return put(refund) as Promise<StripeRefund & Obj>;
      }),
    retrieveSubscription: (id) => get(id),
    retrieveInvoice: (id) => get(id),
    retrieveCharge: (id) => get(id),
    retrieveDispute: (id) => get(id),
    createPortalSession: async (p) => ({
      url: `${origin}/dev/stripe/portal/${encodeURIComponent(p.customer)}?return=${encodeURIComponent(p.returnUrl)}`,
    }),

    async completeCheckout(sessionId) {
      const s = await get<StripeCheckoutSession & Obj>(sessionId);
      if (s.status !== "open") throw new StripeError(400, "checkout_session_not_open", "Session isn't open");
      if (s.expires_at < unix()) throw new StripeError(400, "checkout_session_expired", "Session expired");
      const pi = fakeId("pi");
      const charge: StripeCharge & Obj = {
        id: fakeId("ch"),
        object: "charge",
        payment_intent: pi,
        amount: s.amount_total ?? 0,
        amount_refunded: 0,
      };
      await put(charge);
      await kv.put(`${KEY}:charge_for:${pi}`, charge.id);
      const events: StripeEvent[] = [];
      s.status = "complete";
      s.payment_status = "paid";
      if (s.mode === "subscription") {
        const interval = s.metadata.interval === "year" ? "year" : "month";
        const days = interval === "year" ? 365 : 30;
        const sub: StripeSubscription & Obj = {
          id: fakeId("sub"),
          object: "subscription",
          status: "active",
          customer: s.customer ?? "",
          current_period_end: unix() + days * 86_400,
          cancel_at_period_end: false,
          metadata: s.metadata,
          items: { data: [{ price: { id: `price_fake_${interval}`, recurring: { interval } } }] },
        };
        const invoice: StripeInvoice & Obj = {
          id: fakeId("in"),
          object: "invoice",
          customer: s.customer ?? "",
          subscription: sub.id,
          status: "paid",
          amount_paid: s.amount_total ?? 0,
          payment_intent: pi,
          billing_reason: "subscription_create",
        };
        await put(sub);
        await put(invoice);
        await listAdd(`subs:${sub.customer}`, sub.id);
        s.subscription = sub.id;
        s.invoice = invoice.id;
        await put(s);
        events.push(
          event("checkout.session.completed", s),
          event("customer.subscription.created", sub),
          event("invoice.paid", invoice),
        );
        return events;
      }
      s.payment_intent = pi;
      await put(s);
      events.push(event("checkout.session.completed", s));
      return events;
    },

    async cancelSubscription(subscriptionId, atPeriodEnd) {
      const sub = await get<StripeSubscription & Obj>(subscriptionId);
      if (atPeriodEnd) {
        sub.cancel_at_period_end = true;
        await put(sub);
        return [event("customer.subscription.updated", sub)];
      }
      sub.status = "canceled";
      await put(sub);
      return [event("customer.subscription.deleted", sub)];
    },

    async openDispute(paymentIntent) {
      const chargeId = await kv.get(`${KEY}:charge_for:${paymentIntent}`);
      if (!chargeId) throw new StripeError(404, "resource_missing", "No charge for that payment");
      const ch = await get<StripeCharge>(chargeId);
      const dispute: StripeDispute & Obj = {
        id: fakeId("dp"),
        object: "dispute",
        charge: ch.id,
        payment_intent: paymentIntent,
        status: "needs_response",
        amount: ch.amount,
      };
      await put(dispute);
      return [event("charge.dispute.created", dispute)];
    },

    async subscriptionsFor(customer) {
      return Promise.all((await listGet(`subs:${customer}`)).map((id) => get<StripeSubscription>(id)));
    },
  };
  return api;
}
