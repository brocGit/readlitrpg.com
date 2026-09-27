# Runbook: the owner console

What the console asks of you, and how to undo anything (DESIGN §8, as built in §8.7). Target: under 60 minutes a week.

## The inbox

`admin.readlitrpg.com/inbox`, most urgent first, then whatever decides itself soonest. Each card says what happens if you do nothing: "Auto-approves in 2 d 4 h", "Closes itself in 3 h", or "Waits for you".

| Control | What it does |
|---|---|
| **Approve** / **Reject** | Runs the item's action (publish the listing, schedule the post, apply the change…) and tells the author. Reject takes a reason; its text is what the author reads unless you type a note |
| **Resolve** | For items that only ask you to look (the change is already live, or you fixed it elsewhere) |
| **Approve & trust author** | Approves, and raises the author one trust step (to T1 at most). T1 authors' listings and edits go live at once, and their clean guest posts approve themselves. Set T2 on the author's page only |
| **Snooze** | Hides the card for 4 hours to a week. It comes back by itself, or from **Snoozed (N)** → **Wake now**. Its default still runs on time |
| **Approve all low-risk (N)** | Opens the exact list first. Only items that would approve themselves anyway (or the review says approve), with no risk flag, not urgent, and not a type that always needs you |
| **Open it (e)** | The post, book, profile or run the card is about, to edit before you approve |

Keys: `j`/`k` move, `a` approve, `r` reject, `e` open, `s` snooze a day.

## Undo

Everything you do in the console, and everything that decided itself, is in **Audit log**. Rows marked **Undo** can be reversed for 30 days: a published or hidden book, a field you overrode (your value goes and the next source's returns), a merge, a setting, a trust change, a quiz published or retired, a post published, unpublished or scheduled, a campaign paused or resumed, and inbox approvals (a listing hidden again, a post back in review, a member removed).

Filter with **Can be undone**, or open the link from Sunday's summary. The undo is itself a new audit row. Emails already sent can't be unsent, and an ended campaign stays ended (its places went back on sale).

## What you'll hear, and when

| Email | When |
|---|---|
| **Instant alert** | Security events, disputes, a held editorial run, editorial work waiting with no successful run, and anything at priority 90+ (`owner.alert_min_priority`). Once per item, within 5 minutes |
| **Daily action email** | 13:00 UTC, only if something decides itself within 48 hours or something urgent is open |
| **Sunday summary** | 14:00 UTC: the week in numbers, what decided itself (each with an undo link), next week's newsletters, scheduled posts and booked ads |

They go to every admin account with a verified email. Turn the daily and weekly emails off with `owner.daily_digest` and `owner.weekly_summary`.

### Discord alerts (optional)

Instant alerts can also post to a private Discord channel. In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. Then, without pasting it anywhere else:

```sh
cd apps/jobs
pnpm exec wrangler secret put DISCORD_ALERT_WEBHOOK   # paste the URL at the prompt
```

The URL is a secret: anyone with it can post to the channel. To stop, delete the webhook in Discord and `wrangler secret delete DISCORD_ALERT_WEBHOOK`.

## House ads

Console → **Ads** (DESIGN §11.9, as built in §11.11). Free for you, through the same engine paid ads will use.

- **Backfill** fills any position nobody booked, rotating by weight. Use it for anything always-on: your newsletter, a quiz, your own book.
- **Reserved** takes the position for its dates, like a paid booking. Use it for a launch week. It needs an end date.
- **It's my own book** labels the placement "Sponsored", as the law requires when you promote your own work. Anything else of yours is labeled "From ReadLitRPG".
- **Keep for house** on the inventory calendar holds a period back from future paid sales.

Where nothing is booked or backfilled, the site shows a built-in house ad (Patch Notes, the quizzes, Today in LitRPG, For authors). Email never gets built-ins: an empty newsletter slot is just left out. A change shows on cached pages within their cache time (the homepage within 5 minutes).

Numbers (shown, seen for a second, clicks) arrive hourly once `CF_ACCOUNT_ID` and `CF_API_TOKEN` are set (see `jobs.md`, `stats.rollup`).

## Paid promotions and billing

Console → **Billing** (DESIGN §11.12, §12.9). Nothing here works until Stripe is set up and `flags.ads_paid` is on ([stripe-setup.md](stripe-setup.md)). Most of it runs itself; what reaches you:

| Inbox item | What it is | If you do nothing |
|---|---|---|
| `ad_review` | A paid ad that wasn't approved at once: a new advertiser with a risky line, or a block from the editorial screen. The reasons are on the item | A risky line approves itself 48 hours before the start; an editorial block **rejects** itself 24 hours before, with a full refund. Rejecting asks for a reason, which the author sees |
| `dispute` | A chargeback. The author is already restricted (T-1, undoable from the audit log) and their future campaigns are paused | Answer it in the Stripe dashboard with the order page's details |
| `billing_mismatch` | Reconciliation found something that doesn't add up (a payment with no order of ours, different amounts) | Stays open |
| `price_suggestions` | Once a month, when a price would move 10% or more, with the evidence | Expires after 14 days; prices stay as they are |
| `system_alert` | A Stripe event failed 5 times | Stays open. The item names the event: check it in the Stripe dashboard |

On the Billing page:

- **Refund** part or all of an order from its page, to the card or as credit, with a reason (the author sees it). Refunds, **Give credit** and **Promotion codes** need a passkey sign-in in the last 15 minutes; the console sends you to sign in again if not.
- A **100% code** books without Stripe (a comp); use one for launch partners and giveaways. Codes are case-insensitive and limited to the uses you give them.
- Paid campaigns have their own page (from the order): approve, reject with a refund, or pause.
- **Download … as CSV** gives the month for bookkeeping: orders, refunds and credit movements, in cents.

Rules that refund on their own, so you don't have to: rejection (in full), a cancellation 7 or more days out (in full, to the card or as credit), 2–7 days out (half, as credit), a place lost after payment (in full), and a newsletter slot whose issue didn't go out (as credit).
