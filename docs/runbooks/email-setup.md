# Runbook: reader email (SES, SNS and the link keys)

Everything the M5 reader email needs in production (DESIGN §13). Do it once, in this order. Nothing here goes in the repo: secrets are set with `wrangler secret put` or in the Cloudflare dashboard, and no one needs to see them.

## 1. Sending domains (Amazon SES, `us-east-1`)

1. Verify both identities in SES and publish their DKIM records in Cloudflare DNS (2048-bit Easy DKIM):
   - `mail.readlitrpg.com`: sign-in links and account mail (`EMAIL_FROM`).
   - `news.readlitrpg.com`: Patch Notes, the welcome emails and release alerts (`EMAIL_FROM_NEWS`). A separate subdomain keeps its reputation apart from sign-in links (§13.1).
2. Set a custom MAIL FROM on each (SPF), and a DMARC record starting at `p=none` with aggregate reports.
3. Create two configuration sets, **`rlr-transactional`** and **`rlr-marketing`** (the jobs Worker names them on every send).
4. The IAM user whose keys the jobs Worker holds (`SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY`) needs `ses:SendEmail` on both identities and both configuration sets, nothing else.
5. Request production access if the account is still in the sandbox.

## 2. Bounces and complaints (SNS → the web Worker)

1. Create an SNS topic, e.g. `rlr-ses-events`, in the same region.
2. On **both** configuration sets, add an event destination to that topic for *Bounce*, *Complaint* and *Delivery*.
3. Set the topic ARN on the web Worker (it isn't secret, but it names the AWS account, so it stays out of the repo):

   ```sh
   cd apps/web && pnpm exec wrangler secret put SNS_TOPIC_ARN   # paste the ARN when asked
   ```

4. Add an HTTPS subscription to the topic for `https://readlitrpg.com/api/webhooks/ses`, with *raw message delivery* **off**. The endpoint checks the signature and the certificate host, then confirms the subscription itself; the subscription shows *Confirmed* within a minute.
5. Check: `wrangler tail rlr-web` shows `ses_webhook.subscribed`. A test bounce from the SES mailbox simulator (`bounce@simulator.amazonses.com`) logs `ses_webhook.event` with `kind: "bounce"` and adds a suppression.

What happens to events: a permanent bounce suppresses the address for all mail; a complaint suppresses it and unsubscribes every list; deliveries only update the send log. Transient bounces are ignored. Messages that fail verification get a 403 and change nothing.

## 3. Link signing keys (web and jobs)

Unsubscribe links, one-click book choices and export links are signed with `LINK_SIGNING_KEYS`, a JSON object of key id → secret. Both Workers must hold the **same** value; generate it once in a shell so it's never displayed:

```sh
KEYS=$(printf '{"k1":"%s"}' "$(openssl rand -hex 32)")
printf %s "$KEYS" | (cd apps/web && pnpm exec wrangler secret put LINK_SIGNING_KEYS)
printf %s "$KEYS" | (cd apps/jobs && pnpm exec wrangler secret put LINK_SIGNING_KEYS)
unset KEYS
```

**Rotating:** the first key signs and every key verifies. Unsubscribe links in old emails must keep working, so add a new key *in front* (`{"k2":"new","k1":"old"}`) and keep the old ones. Only drop a key if it leaked, and accept that links it signed stop working (readers can still unsubscribe from the account page).

## 4. Postal address (CAN-SPAM)

Every marketing email carries a postal address (a virtual mailbox or PO box is fine). Until `email.postal_address` is set in **Admin → Settings**, production marketing mail waits and one inbox item says so. Sign-in links and "your export is ready" are not affected.

## 5. Going live checklist

- `EMAIL_PROVIDER` is `ses` on the jobs Worker (the default in `wrangler.jsonc`); `console` refuses to run outside local development.
- `flags.newsletter_send` is on (the kill switch for Patch Notes and release alerts).
- `email.daily_cap` suits the SES sending quota during warm-up; raise it as the quota grows.
- Send yourself a test: subscribe on `/subscribe`, confirm, and check the welcome email arrives from `news.readlitrpg.com` with a working unsubscribe link and *Unsubscribe* button in Gmail (the `List-Unsubscribe` headers).

## If something goes wrong

- **Patch Notes paused itself** (inbox: "paused: too many complaints/bounces"): look at the SES reputation dashboard first. When it's understood, set the issue back to `sending` in D1 and the next run continues from its cursor.
- **A reader says they can't unsubscribe:** there's no console page for this yet (M7), so do it in D1: `UPDATE email_consents SET status='unsubscribed' WHERE user_id = '…'`. Then check `wrangler tail rlr-web` for errors on `/u/…`.
- **Webhook 403s in the logs:** usually a wrong `SNS_TOPIC_ARN`, or raw message delivery switched on.
