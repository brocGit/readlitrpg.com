# Runbook: Stripe (paid promotions and Author Pro)

Everything M8's money features need in production (DESIGN §11, §12). Do it once, in this order. Until it's done, `flags.ads_paid` and `flags.author_pro` stay off and nothing can be bought; house ads keep running. No key or secret goes in the repo or in chat: each is set with `wrangler secret put`, and nobody needs to see it.

## 0. Before selling anything

1. The business entity and bank account (§16.6).
2. **An accountant reviews tax** (§12.7): sales tax on advertising services varies by US state, and a subscription can be taxable. Until they say otherwise, Stripe Tax stays in **monitoring** mode and `billing.automatic_tax` stays `false`.
3. **A lawyer reads the advertising terms** at `/legal/advertising` (the source is `apps/web/src/pages/legal/advertising.astro`), especially refunds and cancellations (§11.10), chargebacks and the content rules. The page says what the code does; change both together.

## 1. The Stripe account

1. Create the account, statement descriptor **`READLITRPG`**, payouts to the business bank account on the default schedule.
2. Radar: keep the default rules, and add *Block if CVC verification fails* and *Request 3D Secure if risk level is elevated* (§12.6).
3. **Customer Portal** (Settings → Billing → Customer portal): allow updating payment methods, viewing invoices and cancelling subscriptions **at the end of the period**. Turn off plan switching and quantity changes. Business name and links: `https://readlitrpg.com/legal/advertising` and `/legal/privacy`.
4. Stripe Tax: turn on **monitoring** only (registration thresholds), not collection.

Do all of this in **test mode** first; the steps below are the same with test keys and a test webhook, and the site works end to end against them.

## 2. Restricted keys (one per Worker)

Create three **restricted** keys (Developers → API keys → Create restricted key), one per Worker, so a leaked key can do only that Worker's part. Everything not listed stays *None*.

| Key name | Worker | Write | Read |
|---|---|---|---|
| `rlr-web` | web | Customers, Checkout Sessions, Coupons, Customer portal, Refunds (an author's own cancellation) | Charges, PaymentIntents |
| `rlr-admin` | admin | Refunds | Checkout Sessions, Charges, PaymentIntents |
| `rlr-jobs` | jobs | Refunds, Checkout Sessions (to expire lost checkouts) | Charges, PaymentIntents, Disputes, Subscriptions, Invoices, Customers |

Set each one straight from the clipboard, so it never lands in a file or the shell history:

```sh
cd apps/web   && pnpm exec wrangler secret put STRIPE_SECRET_KEY   # paste rlr-web's key when asked
cd apps/admin && pnpm exec wrangler secret put STRIPE_SECRET_KEY   # rlr-admin's
cd apps/jobs  && pnpm exec wrangler secret put STRIPE_SECRET_KEY   # rlr-jobs's
```

If a call fails with a permission error, `wrangler tail` names the resource: add that one permission to that Worker's key, nothing wider. `STRIPE_PROVIDER` is `"stripe"` in every `wrangler.jsonc`; the fake Stripe refuses to run anywhere but `ENVIRONMENT=local`.

## 3. The webhook

1. Developers → Webhooks → Add endpoint: `https://readlitrpg.com/api/webhooks/stripe`, API version **2024-06-20** (the version the code pins), with exactly these events:
   - `checkout.session.completed`, `checkout.session.expired`
   - `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `invoice.paid`, `invoice.payment_failed`
2. Set its signing secret on the web Worker:

   ```sh
   cd apps/web && pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET   # paste whsec_… when asked
   ```

3. Check: *Send test webhook* → `checkout.session.completed`. `wrangler tail rlr-web` shows the request answered 200; the test object doesn't exist, so the jobs Worker fails to re-read it, retries, and after 5 tries opens a `system_alert` naming the event. That's expected for a test event: dismiss it. A request without a valid signature gets a 400 and changes nothing.

Events are recorded once (`stripe_events`) and processed by the jobs Worker, which re-reads each object from Stripe before acting, so an old or replayed event can't move money the wrong way. `stripe.reconcile` compares the last 48 hours every night and repairs or reports anything the webhooks missed.

### Rotating the webhook secret

Roll the secret in Stripe with an overlap (e.g. 24 hours), then set both, old first, comma-separated: `old,new`. Once the overlap ends, set the new one alone.

## 4. Author Pro prices

1. Create the product **Author Pro** with two recurring prices: **$9 a month** and **$90 a year** (USD), tax behavior *exclusive*.
2. Put the Price IDs in the console (Settings): `billing.author_pro_price_month` and `billing.author_pro_price_year` (`price_…`; they aren't secret). If you pick other prices, set `billing.author_pro_month_cents` / `billing.author_pro_year_cents` to match, since the site shows those.
3. Author Pro stays off sale while its Price ID is empty, even with the flag on.

## 5. Turning it on

1. Settings → `flags.ads_paid` **on**. Placements go on sale at `ads.prices` (new inventory takes changed prices; bookings keep theirs). The first month's prices are the launch prices (D5); from then on the monthly *price suggestions* inbox item proposes changes (§11.8).
2. Settings → `flags.author_pro` **on**.
3. Make a real $10 Homepage Spotlight booking with your own card on a book you're verified for. It should go paid, then `scheduled` (or into your inbox for review), and show in Admin → Billing. Refund it from the order page, which needs a fresh passkey. The refund shows in Stripe and on the order.
4. Launch credits (§21 step 8): give the first claimed authors credit or a 100% code from Admin → Billing (step-up and audited).

## Every month

- Admin → Billing → *Download … as CSV* for the bookkeeper (pick the month first). Stripe's fees come from its own balance report (Reports → Balance), not from our CSV.
- Disputes open a priority inbox item and restrict the advertiser. Answer them in the Stripe dashboard with the order page's details (creative, dates, delivery).

## Turning it off

`flags.ads_paid` off stops new bookings at once. Booked placements still run and settle. `flags.author_pro` off stops new subscriptions; existing ones continue until cancelled in the portal or in Stripe.
