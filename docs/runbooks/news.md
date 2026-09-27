# Runbook: the blog and the daily news desk

News goes out every day without you (DESIGN §14, as built in §14.9). This is what runs, what reaches your inbox, and how to connect the social accounts.

## Every day

| UTC | What happens |
|---|---|
| Hourly | `news.from_catalog` turns catalog changes into news tips: announcements, date moves, cancellations, completed series |
| Morning | The editorial run (see `editorial-runs.md`) takes the day's `news_scan` item: it looks for publisher announcements, adaptations, awards and sales, and proposes short briefs, each citing the pages it came from |
| Every 10 min | `news.briefs` fetches the cited pages. A brief whose page names its subject publishes (while `news.auto_publish_briefs` is on); anything else waits in the inbox as a news brief |
| 10:30 | `news.daily_roundup` publishes **Today in LitRPG** at `/news/today`, built only from our data and the day's briefs, then posts it to Bluesky and Mastodon if they're set up. A quiet day still publishes, kept out of search (`news.daily_min_items`) |
| 11:00–13:55 | `news.daily_send` emails it to *Patch Notes Daily* readers |

Weekly and monthly roundups (Monday; the 1st and 15th) wait a day in the inbox for a veto while `blog.auto_publish_roundups` is off, then publish themselves. Turn the setting on once a few have looked right.

## What reaches the inbox

| Item | What to do |
|---|---|
| **News brief** | Read the brief and open its sources. Approve publishes it citing them; reject drops it. Nothing publishes without a source that checks out |
| **Post review: roundup** | Skim it. Do nothing and it publishes in a day |
| **Post review: guide drafted** | An editorial run's guide, built only from our catalog. Open it in the editor to change anything, or reject. Otherwise it takes the next guide slot after 3 days (`blog.ai_draft_veto_hours`) |
| **Guest pitch** | A verified author's idea. Approve lets them write it; reject with a note |
| **Post review: guest post / interview** | The editorial review's checklist is on the card. Approve takes the next guest slot (Tuesday or Thursday) and tells the author; request changes from the editor with a note. Clean ones from verified authors approve themselves after 5 days |

Your own posts: Console → **Blog** → Start writing. Book shortcodes render as live cards: `[[book:slug]]`, `[[series:slug]]`, `[[author:slug]]`, `[[releases tag="dungeon-core" month="2026-11"]]`, `[[newsletter-signup]]`. Publish now, schedule a time, or take the next slot of the post's kind. The calendar (Blog → Calendar) moves posts between days.

## Bluesky and Mastodon (optional)

Posting starts the morning after the secrets are set; until then nothing is posted. Never paste these values into chat or a file: type them at the `wrangler` prompt.

**Bluesky** (an account hosted on bsky.social): Settings → Privacy and security → App passwords → Add. Then:

```sh
cd apps/jobs
pnpm exec wrangler secret put BLUESKY_HANDLE         # e.g. readlitrpg.bsky.social
pnpm exec wrangler secret put BLUESKY_APP_PASSWORD   # the app password, never the account password
```

**Mastodon:** on your instance, Preferences → Development → New application, with only the `write:statuses` scope. Then:

```sh
pnpm exec wrangler secret put MASTODON_URL     # e.g. https://mastodon.social
pnpm exec wrangler secret put MASTODON_TOKEN   # "Your access token"
```

A failed post is logged (`social.bluesky_failed`, `social.mastodon_failed`) and never blocks the news. To stop, revoke the app password or application and delete the secrets. Reddit is never posted to automatically; share there by hand.
