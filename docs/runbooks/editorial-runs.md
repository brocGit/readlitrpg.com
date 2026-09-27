# Runbook: editorial runs

Editorial runs are Claude sessions that do the site's AI work: classifying books, pre-judging duplicates, confirming seeds with cited sources, and moderation. The site never calls a language model (DESIGN §7.1).

A run follows `.claude/skills/editorial-run/SKILL.md`:

1. It takes work from the queue on `admin.readlitrpg.com` with `pnpm editorial`.
2. It pushes proposals back.
3. The server checks every proposal, and a fixed policy decides what's applied.

Anything the policy holds lands in the Owner Inbox and on **Admin → Editorial**.

## One-time setup (after the first deploy)

Two locks guard the editorial API:

- a **Cloudflare Access service token** (Access checks it before the Worker sees the request, and the Worker checks it again);
- an **editorial token** (the Worker stores only its SHA-256).

Never paste either into a chat.

### Part A: owner (about 10 minutes)

1. **Service token.** In Zero Trust, go to Access → Service credentials → Service Tokens → Create. Name it `rlr-editorial` and set the duration to 1 year.
   - Cloudflare shows the Client ID and Client Secret once. Put them straight into the Claude environment's settings (the environment menu in the session's title bar → Edit) as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Use the *API credentials* section if offered, otherwise environment variables.
2. **Let it through Access.** Open the `admin.readlitrpg.com` application and add a policy: Action *Service Auth*, Include → *Service Token* → `rlr-editorial`. Keep your own *Owner* policy as it is.
3. **Editorial token.** In a terminal with the repository and Wrangler logged in:

   ```sh
   TOKEN=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
   printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1 | (cd apps/admin && pnpm exec wrangler secret put EDITORIAL_TOKEN_HASH)
   printf %s "$TOKEN" | pbcopy      # macOS; on Linux: xclip -selection clipboard
   unset TOKEN
   ```

   Paste the clipboard into the Claude environment's settings as `EDITORIAL_TOKEN`, then clear the clipboard.
4. **Network access** for the Claude environment: allow `admin.readlitrpg.com`, plus the package registry `pnpm install` needs. Research runs also need web search.

### Part B: Claude session (with the three values in the environment)

```sh
cd apps/admin
printf %s "$CF_ACCESS_CLIENT_ID" | pnpm exec wrangler secret put EDITORIAL_ACCESS_CLIENT_IDS
cd ../..
pnpm install
pnpm editorial status --env production      # proves both locks open
```

Then create the scheduled routines below. A Claude session can do this: ask it to "set up the editorial routines".

### Optional: embeddings

`vectors.update` embeds books with Workers AI. To turn it on:

1. Create a Cloudflare API token with the *Workers AI* permission, limited to this account.
2. Set it on the jobs Worker with `wrangler secret put CF_API_TOKEN`, and set `CF_ACCOUNT_ID` the same way.

Without these the job does nothing, and duplicate checks use titles only.

## Scheduled routines

Times are US Eastern. Each routine starts a fresh session in this repository with the prompt shown.

| Routine | When | Prompt |
|---|---|---|
| Morning | daily 05:30 | "Use the editorial-run skill for a daily run against production, labeled morning. Clear moderation and image review, then classify up to 80 books, then the dedupe questions, then up to 15 research items. Finish with notes." |
| Afternoon | daily 14:00 | "Use the editorial-run skill for a daily run against production, labeled afternoon. Work whatever the morning left in the queue, most urgent first, up to 120 items. Finish with notes." |
| Quiz factory | Tuesdays 09:00 | "Use the quiz-factory skill: draft the next quiz from data/quizzes/BRIEFS.md and open a pull request for it." |
| Monthly eval | 1st, 07:00 | "Run the classification eval: `pnpm editorial eval-input`, classify the file blind following the editorial-classify skill (don't read data/eval), then `pnpm eval:classify <your proposals file>`. Report the metrics and whether the gate passed. Don't change any files in the repository." |

The news desk and audit runs join these as their milestones land. The quiz factory needs no editorial token: it only writes to the repository. Merging its pull request is your content review. After the deploy, the quiz goes live in 48 hours unless you retire it (inbox item `quiz_ready`).

## Running one by hand

- **Against production:** in any Claude session with the environment above, say "run editorial" or "classify the backlog". The editorial-run skill takes it from there.
- **Locally:**
  1. `pnpm dev:admin`, with the local migrations applied.
  2. `pnpm editorial start --env local`, then `pull`, `push` and `finish`.

  The local token is well known and works only against localhost with `ENVIRONMENT=local`.

## Watching it

- **Admin → Editorial** shows:
  - queue depth by kind;
  - every run with its counts, and each run's proposals with their outcome and reasons;
  - everything held for you, with **Apply** and **Discard**.
- **Inbox items:**
  - `classification_review`: a held classification;
  - `editorial_run_held`: the circuit breaker tripped;
  - `editorial_stale`: work waiting with no successful run for 36 hours;
  - `seed_check`: research couldn't find a seed, or found different details;
  - `scope_check`: a run marked a book out of scope;
  - `security_event`: a bad editorial token;
  - `quiz_ready`: a new quiz that goes live after 48 hours unless you retire it in Admin → Quizzes.
- Each book page shows its classification, dials and stats with their sources, the proposals about it, and a **Classify next** button.

## Rotating or revoking

- **Editorial token (quarterly):** generate a new one as in Part A step 3.
  1. Set `EDITORIAL_TOKEN_HASH` to `<old hash>,<new hash>` so both work.
  2. Update `EDITORIAL_TOKEN` in the environment.
  3. After the next successful run, set the secret to the new hash alone.
- **Service token:** create a new one and add it to the Access policy. Set `EDITORIAL_ACCESS_CLIENT_IDS` to both IDs, comma-separated. Update the environment, then delete the old token in Zero Trust.
- **If either may have leaked:**
  1. Switch **Settings → `flags.editorial_api`** off. Every run is refused at once.
  2. Rotate.
  3. Switch it back on.

## When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `access_login_page` or a 403 `service_token_*` | The service token is missing, wrong, or not in the Access policy / `EDITORIAL_ACCESS_CLIENT_IDS` | Part A steps 1–2, Part B |
| 401 `bad_token` (and a `security_event` item) | `EDITORIAL_TOKEN` doesn't match `EDITORIAL_TOKEN_HASH` | Rotate the token |
| 503 `editorial_api_off` | The kill switch is off | Settings → `flags.editorial_api` |
| 409 `run_on_hold` | The run tripped the circuit breaker | Review the run's held proposals; the next run starts clean |
| Many `rejected` proposals | The checkout is behind the deployed taxonomy (the CLI warns at `start`), or a skill needs work | Pull main; run the eval |
| Research never confirms | Cited pages don't show the title and author in plain HTML | Nothing to fix: the seed stays a draft, and is researched again after 30 days |
