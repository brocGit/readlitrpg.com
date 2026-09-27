# Runbook: rotate secrets (quarterly, or at once if one may have leaked)

| Secret | Where | Rotate by | Side effect |
|---|---|---|---|
| `AUTH_SECRET` | web | `openssl rand -base64 48 \| pnpm exec wrangler secret put AUTH_SECRET` in `apps/web` | Every reader is signed out |
| `ADMIN_AUTH_SECRET` | admin | same, in `apps/admin` | You are signed out of the console |
| `IP_HASH_SALT_SEED` | web | same | Rate-limit windows start over |
| `TURNSTILE_SECRET` | web | Turnstile dashboard → rotate, then set it in the Worker | None |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | jobs | Create a new IAM key, set both, then delete the old key | None if done in that order |
| `CLOUDFLARE_API_TOKEN` | GitHub env + Claude env | Roll it in the Cloudflare dashboard and update both secret stores | None |
| Editorial token | admin (`EDITORIAL_TOKEN_HASH`) + Claude env (`EDITORIAL_TOKEN`) | Two hashes side by side, then the new one alone: [editorial-runs.md](editorial-runs.md#rotating-or-revoking) | None if done in that order |
| Access service token (`rlr-editorial`) | Zero Trust + admin (`EDITORIAL_ACCESS_CLIENT_IDS`) + Claude env | [editorial-runs.md](editorial-runs.md#rotating-or-revoking) | None if both IDs are allowed during the switch |
| `LINK_SIGNING_KEYS` | web + jobs (same value) | Add a new key in front and keep the old ones: [email-setup.md](email-setup.md#3-link-signing-keys-web-and-jobs) | None; dropping an old key breaks the unsubscribe links it signed |
| `SNS_TOPIC_ARN` | web | Only changes with the topic: set the new ARN, then move the SES event destinations | Bounce and complaint events are refused until both match |
| `CF_API_TOKEN` (Workers AI) | jobs | Roll it in the Cloudflare dashboard, then `wrangler secret put CF_API_TOKEN` in `apps/jobs` | Embeddings pause until updated |

If a secret may have leaked, also:

1. Turn on `flags.read_only_mode` if data could be at risk, or `flags.editorial_api` off if it's the editorial token.
2. Bump `session.epoch` to the current Unix time to end every session.
3. Check the audit log (admin → Audit log → *Verify the chain now*) and the inbox.
