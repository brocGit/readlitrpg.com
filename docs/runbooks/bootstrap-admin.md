# Runbook: make the owner an admin

The admin console (admin.readlitrpg.com) has two locks: Cloudflare Access, then a passkey. The passkey is the one you register on the main site, and your account there must be flagged as admin. The site has no button that grants admin, on purpose.

1. On https://readlitrpg.com/signin, sign in with the **same email** your Access policy allows.
2. On the account page, choose **Add a passkey** and save it (phone, laptop or security key).
3. Flag the account (a Claude session with the API token can run this, or you can in the D1 console):

   ```sh
   cd apps/admin
   pnpm exec wrangler d1 execute DB --remote \
     --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
   ```

4. Open https://admin.readlitrpg.com. Access asks who you are first, then the console asks for your passkey.

To remove an admin: the same command with `is_admin = 0`, then bump the `session.epoch` setting to the current Unix time to sign every session out.

## Locally

`apps/admin/.dev.vars` sets `ACCESS_DEV_EMAIL` (default `owner@example.com`) to stand in for Access. Sign up with that email on http://localhost:4321, add a passkey, then:

```sh
cd apps/admin
pnpm exec wrangler d1 execute DB --local --persist-to ../../.wrangler/state \
  --command "UPDATE users SET is_admin = 1 WHERE email = 'owner@example.com'"
```
