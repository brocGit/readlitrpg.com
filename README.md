# ReadLitRPG.com

A free discovery engine, book database and marketing network for LitRPG, progression fantasy, GameLit and cultivation fiction. Tell it three books you loved and it finds your next read. A release calendar grows in behind it.

**Status:** M0 (foundations) through M7 (owner console, blog and news, house ads) are built:

- three Cloudflare Workers, passwordless sign-in, the owner console behind Cloudflare Access, the job scheduler, the audit log and CI;
- the catalog: taxonomy, provenance, duplicate detection, Open Library and Google Books lookups, CSV and seed imports, and merges, with a first seed of 101 series;
- editorial runs: Claude sessions that classify, pre-judge duplicates and confirm seeds with cited sources, through a locked-down API, a CLI, a publish policy and an eval harness ([runbook](docs/runbooks/editorial-runs.md));
- discovery: matches from books you loved or the nine-step Match Quiz, with reasons, honest heads-ups and a reader class; `/find`, "books like X" pages, living lists, Appraise, and the quiz engine with shareable results and Party up;
- the public site: book, series, author, narrator and tag pages with structured data, New & upcoming, RSS and calendar feeds, sitemaps, licensed covers, PNG share images and cookie-free page counts;
- readers and email: double opt-in signup from quiz results, matches and searches, onboarding with profile levels, follows with release-day emails, book marks, saved searches, a private calendar, Goodreads/StoryGraph import, export and account deletion, the welcome emails and the weekly *Patch Notes*, one-click unsubscribe, and verified SES bounce and complaint handling;
- authors: claim or create a profile, verify it (website, DNS, email domain, Bluesky, or a check by hand), submit books (live straight away once verified), edit under protected-field rules, a team, per-book stats including match appearances, a daily note of changes others made, "Still on for …?" release check-ins, and a pasted book list turned into drafts by an editorial run;
- the blog and a daily news desk: posts with live book cards from shortcodes, a validator that keeps automated posts to our own data, an editorial calendar, weekly and monthly release roundups, guides drafted by editorial runs, guest posts and interviews from verified authors, cited news briefs, and *Today in LitRPG* every morning on the site, by email (*Patch Notes Daily*) and on Bluesky and Mastodon;
- the owner console: an inbox with countdowns, reasons, snooze, bulk approval of low-risk items and keyboard shortcuts; undo for 30 days from the audit log; a daily action email only when needed, a Sunday summary and instant alerts;
- ads: the real engine (slots, inventory, serving, labeled placements, `/go/` click redirects, served and viewable impressions) running house campaigns on the homepage, tag and "books like" pages and in *Patch Notes*.

It runs locally; going live needs the Cloudflare account ([runbook](docs/runbooks/cloudflare-setup.md)) and, for email, Amazon SES ([runbook](docs/runbooks/email-setup.md)). M8 (paid ads, Stripe and Author Pro) is next.

## Documents

| Doc | What it covers |
|---|---|
| [`docs/STRATEGY.md`](docs/STRATEGY.md) | The strategy: the database and calendar for search, matching and quizzes for onboarding, and the *Patch Notes* newsletter and news brand, combined into one flywheel |
| [`docs/DESIGN.md`](docs/DESIGN.md) | The full system design: architecture, data model, AI automation, owner approval inbox, ads and payments, email, blog, security, privacy, costs, and build plan |
| [`docs/QUIZZES.md`](docs/QUIZZES.md) | Quiz lead magnets: 8 drafted (personality, trivia and series fan quizzes; previews in [`docs/quizzes/`](docs/quizzes/)), the lead-gen funnel, the welcome email sequence and onboarding |
| [`docs/TAXONOMY.md`](docs/TAXONOMY.md) | The starter tag vocabulary, the 17 taste dials and the 12 book stats (Competent MC, Rule of Cool, Number Go Up…) that power matching |
| [`docs/runbooks/`](docs/runbooks/) | Operations: Cloudflare setup and first deploy, email (SES, SNS, link keys), making the owner an admin, author decisions in the inbox, the owner console (inbox, undo, alerts, house ads), the news desk and social accounts, rotating secrets, scheduled jobs |
| [`CLAUDE.md`](CLAUDE.md) | Conventions, commands and gotchas for Claude sessions working on the code |

## Stack at a glance

- **Hosting:** Cloudflare Workers, D1 (SQLite), R2, Queues, Workflows, Vectorize.
- **Site:** Astro 7 (SSR) with small Preact islands, TypeScript and Drizzle.
- **Auth:** Better Auth, using passkeys and magic links (no passwords).
- **Payments:** Stripe Checkout, Billing and the Customer Portal.
- **Email:** Amazon SES.
- **AI:** scheduled Claude editorial runs (no AI API keys in the app, no per-token bill), plus Workers AI embeddings.
- **Expected running cost:** about $7–10/month at launch.

## Working on the code

```sh
pnpm install
pnpm check    # lint, typecheck, unit tests, quiz check
```

Local development, the E2E tests and the project's rules are in [`CLAUDE.md`](CLAUDE.md).

## Quiz drafts

Quiz content lives in `data/quizzes/*.json`. To validate every quiz, run a 10,000-reader balance simulation and regenerate the previews in `docs/quizzes/`:

```sh
node scripts/quiz-tool.mjs render
```
