# ReadLitRPG.com

A free discovery engine, book database and marketing network for LitRPG, progression fantasy, GameLit and cultivation fiction. Tell it three books you loved and it finds your next read. A release calendar grows in behind it.

**Status:** design phase. No application code yet.

## Documents

| Doc | What it covers |
|---|---|
| [`docs/STRATEGY.md`](docs/STRATEGY.md) | The strategy: the database and calendar for search, matching and quizzes for onboarding, and the *Patch Notes* newsletter and news brand, combined into one flywheel |
| [`docs/DESIGN.md`](docs/DESIGN.md) | The full system design: architecture, data model, AI automation, owner approval inbox, ads and payments, email, blog, security, privacy, costs, and build plan |
| [`docs/QUIZZES.md`](docs/QUIZZES.md) | Quiz lead magnets: 8 drafted (personality, trivia and series fan quizzes; previews in [`docs/quizzes/`](docs/quizzes/)), the lead-gen funnel, the welcome email sequence and onboarding |
| [`docs/TAXONOMY.md`](docs/TAXONOMY.md) | The starter tag vocabulary, the 17 taste dials and the 12 book stats (Competent MC, Rule of Cool, Number Go Up…) that power matching |

## Stack at a glance

- **Hosting:** Cloudflare Workers, D1 (SQLite), R2, Queues, Workflows, Vectorize.
- **Site:** Astro (SSR) with small Preact islands, TypeScript and Drizzle.
- **Auth:** Better Auth, using passkeys and magic links (no passwords).
- **Payments:** Stripe Checkout, Billing and the Customer Portal.
- **Email:** Amazon SES.
- **AI:** scheduled Claude editorial runs (no AI API keys in the app, no per-token bill), plus Workers AI embeddings.
- **Expected running cost:** about $7–10/month at launch.

## Quiz drafts

Quiz content lives in `data/quizzes/*.json`. To validate every quiz, run a 10,000-reader balance simulation and regenerate the previews in `docs/quizzes/`:

```sh
node scripts/quiz-tool.mjs render
```
