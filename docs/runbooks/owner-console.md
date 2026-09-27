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
