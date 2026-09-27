// Starting Author Pro (DESIGN §11.2): a Stripe Checkout subscription for an author profile, at the
// Price IDs in settings. Stripe runs renewals, receipts and dunning; the portal handles cancelling.

import { advertiserForAuthor, ensureStripeCustomer } from "../ads/paid";
import type { Db } from "../db";
import type { Settings } from "../settings";
import type { StripeApi } from "./stripe";
import { activePro } from "./subscriptions";

export class ProError extends Error {}

export async function startProCheckout(
  db: Db,
  stripe: StripeApi | null,
  req: {
    authorId: string;
    userId: string;
    email: string;
    interval: "month" | "year";
    settings: Settings;
    siteOrigin: string;
    now?: Date;
  },
): Promise<string> {
  const { settings } = req;
  const price =
    req.interval === "year"
      ? settings["billing.author_pro_price_year"]
      : settings["billing.author_pro_price_month"];
  if (!settings["flags.author_pro"] || !price) throw new ProError("Author Pro isn't on sale yet");
  if (!stripe) throw new ProError("card payments aren't set up yet");
  const advertiser = await advertiserForAuthor(db, req.authorId);
  if (await activePro(db, advertiser.id)) throw new ProError("this profile already has Author Pro");
  const customer = await ensureStripeCustomer(db, stripe, advertiser, req.email);
  const amount =
    req.interval === "year"
      ? settings["billing.author_pro_year_cents"]
      : settings["billing.author_pro_month_cents"];
  const back = `${req.siteOrigin}/dashboard/billing?author=${req.authorId}`;
  // One session a minute at most for the same choice: a double click reuses it.
  const minute = Math.floor((req.now ?? new Date()).getTime() / 60_000);
  const session = await stripe.createCheckoutSession(
    {
      mode: "subscription",
      customer,
      lineItems: [{ price }],
      successUrl: `${back}&pro=1`,
      cancelUrl: back,
      clientReferenceId: advertiser.id,
      metadata: {
        advertiser_id: advertiser.id,
        user_id: req.userId,
        plan: "author_pro",
        interval: req.interval,
        amount_cents: String(amount),
      },
      automaticTax: settings["billing.automatic_tax"],
    },
    `pro:${advertiser.id}:${req.interval}:${minute}`,
  );
  if (!session.url) throw new ProError("Stripe didn't return a checkout page");
  return session.url;
}
