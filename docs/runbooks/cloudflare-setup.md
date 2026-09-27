# Runbook: Cloudflare account setup and first deploy

Everything in M0 runs locally today. This runbook takes it live. **Part A is yours** (it needs your identity, a card, or your domain registrar). **Part B is mine**: once a scoped API token is in the environment secrets, a Claude session runs it and commits the resource IDs.

Never paste a token or key into chat. Tokens go into the environment's secret settings (for Claude sessions) or GitHub's secret settings (for CI). Secrets the Workers need are generated and set by command, so nobody ever sees them.

## Part A: owner (about 30 minutes)

1. **Create a Cloudflare account** and subscribe to **Workers Paid** ($5/month). One account holds everything.
2. **Add the domain** readlitrpg.com to Cloudflare, and switch the registrar's nameservers to the two Cloudflare gives you. Wait for "Active".
3. **Zero Trust → Access → Applications → Add → Self-hosted**:
   - Application domain: `admin.readlitrpg.com` (all paths).
   - Policy "Owner": Allow, *Include: Emails = your email*, *Require: Authentication method = MFA* (or a passkey/hardware-key identity provider).
   - Copy the **Application Audience (AUD) tag**. It isn't secret: put it in the environment variable `ACCESS_AUD` (or tell Claude it; it's safe to share).
   - Note your team domain (`https://<team>.cloudflareaccess.com`).
4. **Turnstile → Add widget** for `readlitrpg.com` (Managed mode). The **site key** is public; the **secret key** is not (it goes in with Part B step 5, via your terminal or the dashboard).
5. **API token** (My Profile → API Tokens → Create Token → Custom):
   - Permissions: *Account · Workers Scripts · Edit*, *Account · D1 · Edit*, *Account · Workers KV Storage · Edit*, *Account · Workers R2 Storage · Edit*, *Account · Queues · Edit*, *Zone · Workers Routes · Edit* and *Zone · DNS · Edit* (readlitrpg.com; custom domains create their DNS records), *Account · Account Settings · Read*.
   - Account resources: only this account. Zone resources: only readlitrpg.com.
   - Save it as the secret `CLOUDFLARE_API_TOKEN` in **both** places:
     - GitHub → Settings → Environments → **production** (create it; add yourself as a *required reviewer*).
     - The Claude environment's secrets, so a session can run Part B.
   - Also save `CLOUDFLARE_ACCOUNT_ID` (from the dashboard sidebar) in the same two places.
6. **GitHub**: Settings → Branches → protect `main` (require a pull request and the *CI* checks). Settings → Variables → add `DEPLOY_ENABLED = true` **after** Part B is merged.
7. **Amazon SES** (start now; production access takes a few days): request production access in `us-east-1`, verify the domain `mail.readlitrpg.com` (DKIM records go into Cloudflare DNS), create an IAM user with send-only permission for that identity, and put its keys into the jobs Worker with `wrangler secret put` (Part B step 5) or the Cloudflare dashboard.

## Part B: Claude session (about 15 minutes, with the token in the environment)

Run from the repository root.

```sh
# 1. Resources (names match the wrangler.jsonc files)
pnpm --filter @rlr/web exec wrangler d1 create rlr-db
pnpm --filter @rlr/web exec wrangler kv namespace create CONFIG
pnpm --filter @rlr/jobs exec wrangler r2 bucket create rlr-backups
for q in rlr-jobs rlr-email rlr-jobs-dlq rlr-email-dlq; do pnpm --filter @rlr/jobs exec wrangler queues create "$q"; done

# 2. Backup lifecycle (DESIGN §15.12): 35 daily copies, 12 monthly
pnpm --filter @rlr/jobs exec wrangler r2 bucket lifecycle add rlr-backups daily d1/daily/ --expire-days 35
pnpm --filter @rlr/jobs exec wrangler r2 bucket lifecycle add rlr-backups monthly d1/monthly/ --expire-days 366
```

3. Put the printed D1 `database_id` and KV `id` into `apps/web/wrangler.jsonc`, `apps/admin/wrangler.jsonc` and `apps/jobs/wrangler.jsonc` (replacing the `00000000…` placeholders). Put `ACCESS_AUD`, the team domain and the Turnstile site key into the vars. Run `pnpm --filter @rlr/web exec wrangler types` (and for admin and jobs), then commit.
4. Apply migrations: `cd apps/web && pnpm exec wrangler d1 migrations apply DB --remote`.
5. Secrets, generated so no one sees them:

```sh
cd apps/web
openssl rand -base64 48 | pnpm exec wrangler secret put AUTH_SECRET
openssl rand -base64 48 | pnpm exec wrangler secret put IP_HASH_SALT_SEED
cd ../admin
openssl rand -base64 48 | pnpm exec wrangler secret put ADMIN_AUTH_SECRET
```

   `TURNSTILE_SECRET` (web) and `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` (jobs) come from other services, so the owner sets them in the Cloudflare dashboard (Worker → Settings → Variables and Secrets) or with `wrangler secret put` in their own terminal.
6. First deploy: `cd apps/jobs && pnpm exec wrangler deploy`, then `pnpm --filter @rlr/web run deploy` and `pnpm --filter @rlr/admin run deploy`. Check `https://readlitrpg.com/healthz` returns `{"ok":true}`.
7. Make the owner an admin: [bootstrap-admin.md](bootstrap-admin.md).
8. Set `DEPLOY_ENABLED=true` in GitHub. From then on every merge to `main` deploys after your approval.
9. Editorial runs (M2): the service token, the editorial token and the scheduled routines are in [editorial-runs.md](editorial-runs.md).

## Staging (before launch)

Repeat Part B with `-staging` names (`rlr-db-staging`, `rlr-staging-email`, …) under `env.staging` blocks in each `wrangler.jsonc`, route `staging.readlitrpg.com` behind the same Access policy, and add a `staging` job to `deploy.yml` that runs before production.
