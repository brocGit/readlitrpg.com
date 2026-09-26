# ReadLitRPG.com

A free discovery engine, book database and marketing network for LitRPG, progression fantasy, GameLit and cultivation fiction. Tell it three books you loved and it finds your next read. A release calendar grows in behind it.

**Status:** design phase. No application code yet.

## Documents

| Doc | What it covers |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | The full system design: architecture, data model, AI automation, owner approval inbox, ads and payments, email, blog, security, privacy, costs, and build plan |
| [`docs/TAXONOMY.md`](docs/TAXONOMY.md) | The starter tag vocabulary, the 17 taste dials and the 12 book stats (Competent MC, Rule of Cool, Number Go Up…) that power matching |

## Stack at a glance

- **Hosting:** Cloudflare Workers, D1 (SQLite), R2, Queues, Workflows, Vectorize.
- **Site:** Astro (SSR) with small Preact islands, TypeScript and Drizzle.
- **Auth:** Better Auth, using passkeys and magic links (no passwords).
- **Payments:** Stripe Checkout, Billing and the Customer Portal.
- **Email:** Amazon SES.
- **AI:** Claude API with batches and structured outputs, plus Workers AI embeddings.
- **Expected running cost:** about $15–30/month at launch.
