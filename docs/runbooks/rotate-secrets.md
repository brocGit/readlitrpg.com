# Runbook: rotate secrets (quarterly, or at once if one may have leaked)

| Secret | Where | Rotate by | Side effect |
|---|---|---|---|
| `AUTH_SECRET` | web | `openssl rand -base64 48 \| pnpm exec wrangler secret put AUTH_SECRET` in `apps/web` | Every reader is signed out |
| `ADMIN_AUTH_SECRET` | admin | same, in `apps/admin` | You are signed out of the console |
| `IP_HASH_SALT_SEED` | web | same | Rate-limit windows start over |
| `TURNSTILE_SECRET` | web | Turnstile dashboard → rotate, then set it in the Worker | None |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | jobs | Create a new IAM key, set both, then delete the old key | None if done in that order |
| `CLOUDFLARE_API_TOKEN` | GitHub env + Claude env | Roll it in the Cloudflare dashboard and update both secret stores | None |
| Editorial token (M2) | admin (hash) + Claude env | Documented with the editorial API | Scheduled runs pause until updated |

If a secret may have leaked, also:

1. Turn on `flags.read_only_mode` if data could be at risk, or `flags.editorial_api` off if it's the editorial token.
2. Bump `session.epoch` to the current Unix time to end every session.
3. Check the audit log (admin → Audit log → *Verify the chain now*) and the inbox.
