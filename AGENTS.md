# AGENTS.md

Calendar Feeds: one Cloudflare Worker that turns Soma rows (tasks,
trips, calendar events) into three iCalendar feeds and mirrors them, one
way, into three Google calendars. README.md has the user-facing behavior.

## Layout

```
src/feeds.ts      pure: eligibility rules, row -> event, RFC 5545 builder
src/google.ts     Google: event id derivation, upsert diff, fetch-based client
src/index.ts      Worker: feed routes (token check, Cache API) + hourly cron
scripts/provision.py     bootstrap minters (CF deploy token, Soma token, feed tokens)
scripts/google-oauth.py  one-time consent flow printing the Google refresh token
scripts/cf-kv.py         ensures the KV namespace declared in wrangler.jsonc exists
```

## Resources owned

- Worker `calendar-feeds` (workers.dev, no custom domain), Cron Trigger
  `0 * * * *`.
- KV namespace `calendar-feeds-state` (binding `STATE`): keys
  `calendar:{tasks,trips,events}` hold the Google calendar ids. Created by
  `scripts/cf-kv.py`, which reads the declaration from `wrangler.jsonc`.
- 1Password vault `Calendar Feeds`: `Calendar Feeds ENV` (all Worker
  secrets), `Calendar Feeds CI Cloudflare Token` (Workers Scripts Write,
  account scope), `Calendar Feeds CI op Service Account Token` for the
  read-only `calendar-feeds-ci` SA (the repo's only GH secret).
- Google: the project's own OAuth client (Desktop app) and refresh token,
  scope `calendar.app.created`; never the agent's gog credentials.

## Approved boundary (shared nothing)

- Soma is reached only through its hub API with this project's own
  token, named `calendar-feeds-<8 hex>` (current: `calendar-feeds-7e1d279b`).
  Its grant is exact read-only columns, `tables:read:<table>:<col>` for:
  - `tasks`: id, title, status, due_date, updated_at, deleted_at
  - `trips`: id, name, status, start_on, end_on, cities, countries, updated_at, deleted_at
  - `calendar_events`: id, title, status, date, start_at, end_at, updated_at, deleted_at

  These lists are `FEEDS` in `src/index.ts` and `COLUMNS` in
  `scripts/provision.py`; a test keeps them equal. A new column means a new
  token: mint with `provision.py --field SOMA_HUB_TOKEN` (operator authority
  for the `soma` CLI), store it, deploy, verify, then `soma token revoke`
  the old name.

- No D1/R2/KV bindings of Soma or any other project, no writes
  anywhere in Soma, no Cloudflare Access (the feed token in the URL is
  the auth; there are no admin routes).

## Conventions

- TDD: specs sit next to the code (`*.spec.ts`, vitest); scripts have
  `scripts/test_*.py`. `just test` and `just check` before every push.
- Deploying = pushing to `main` (`.github/workflows/deploy.yml`: test,
  `wrangler deploy`, then `scripts/sync-secrets.sh`). Watch the run with
  `gh run watch <id> --exit-status`.
- Timezone is America/New_York for every date decision.

## Gotchas

- `global_fetch_strictly_public` in `wrangler.jsonc` is load-bearing: the
  Soma hub is a workers.dev Worker on the same account, and without it
  every hub fetch fails with Cloudflare error 1042.
- A `CHANGEME` Google field disables the cron push; it never errors.
- Secrets reach the Worker only on deploy. After editing the ENV item, run
  `gh workflow run deploy.yml`.
- The Cache API is documented as functional on custom domains; on
  workers.dev a miss simply reads the hub again (responses still carry
  `Cache-Control: max-age=300` for clients). Each read is a batched pull of
  up to 5,000 rows, so a feed costs one or two hub requests. Incremental
  reads (Soma's table-pull helper) would need `hub_at` in the token's grant.
- `op-project-bootstrap` prompts with `getpass`, which flushes piped input;
  answer its `GOOGLE_*` prompts interactively (or with `expect`).
