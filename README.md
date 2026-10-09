# Calendar Feeds

Three read-only calendars built from Soma - **Tasks**, **Trips** and
**Events** - served as iCalendar feeds and pushed into Google Calendar. Soma
Data owns every entry; calendars only display them, and nothing is ever
written back.

One Cloudflare Worker does both jobs:

- `GET /feeds/{tasks,trips,events}.ics?token=<feed token>` returns RFC 5545
  text (America/New_York VTIMEZONE, `UID` = Soma row id, `DTSTAMP` = the
  row's `updated_at`), cached for 5 minutes.
- An hourly Cron Trigger mirrors the same events into three Google calendars
  it created, once the Google OAuth secrets exist.

## What lands on each calendar

| Calendar | Source table      | Included                                                                              | Shape                                                                                |
| -------- | ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Tasks    | `tasks`           | status To Do or In Progress, with a due date, any priority, with or without a project | all-day on the due date (a due instant counts on its New York day)                   |
| Trips    | `trips`           | every status except Canceled, with a start date                                       | all-day from `start_on` through `end_on`; location = cities, else countries          |
| Events   | `calendar_events` | every status except Canceled, with a date or start time                               | timed when `start_at` is set (end defaults to one hour), otherwise all-day on `date` |

Deleted rows never appear. The Tasks feed stays empty until Soma's
`tasks` table takes over from the current task workflow.

## Subscribe to a feed

The three feed URLs are
`https://calendar-feeds.<workers-subdomain>.workers.dev/feeds/<name>.ics?token=<token>`,
with each token in the `Calendar Feeds ENV` item (`FEED_TOKEN_TASKS`,
`FEED_TOKEN_TRIPS`, `FEED_TOKEN_EVENTS`). The token is the only credential:
treat a feed URL like a password.

- **Google Calendar**: Settings > Add calendar > From URL, paste the URL.
  Google refreshes subscriptions on its own schedule (hours), which is why
  the push mode below exists.
- **iPhone**: Settings > Apps > Calendar > Calendar Accounts > Add Account >
  Other > Add Subscribed Calendar (older iOS: Settings > Calendar >
  Accounts), paste the URL. Pick the refresh rate under Fetch New Data
  (every 15 minutes is the fastest iOS offers).
- **Mac Calendar**: File > New Calendar Subscription, paste the URL, set
  Auto-refresh to every 5 minutes.

## Google push mode

Every hour the Worker refreshes a Google access token, creates any of the
three calendars it has not created yet (their ids live in the Worker's KV
namespace), and upserts each qualifying row as an event whose id is the
base32hex encoding of the Soma row id. Events whose rows stop
qualifying are deleted. The OAuth scope is `calendar.app.created`, so the
app can only see calendars it created. Edits made in Google are overwritten
on the next run.

The push stays off while any `GOOGLE_*` field in `Calendar Feeds ENV` is
`CHANGEME`. To turn it on (once):

1. In Google Cloud console, in a project for Calendar Feeds: enable the
   Google Calendar API; configure the OAuth consent screen (External,
   add the scope `.../auth/calendar.app.created`, add yourself as a test
   user, then **Publish app** so refresh tokens do not expire after 7 days);
   create an OAuth client ID of type **Desktop app** and download its JSON.
2. On a machine with a browser: `scripts/google-oauth.py <client.json>` and
   approve the consent screen with the Google account whose calendar should
   receive the events. It prints three lines.
3. Paste them into the `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_REFRESH_TOKEN` fields of `Calendar Feeds ENV`, then redeploy so
   the Worker gets them: `gh workflow run deploy.yml -R alexjmiller5/calendar-feeds`.
   The next hourly run creates the calendars.

To start over in Google, delete the three calendars there and the
`calendar:*` keys in the KV namespace; the next run recreates them.

## Develop

```bash
bun install
just test     # vitest + operator script tests
just check    # wrangler types, tsc, prettier, ruff
just dev      # local Worker with secrets from 1Password
```

Deploying is pushing to `main`: CI tests, deploys the Worker and pushes the
secrets from `.env.tpl`. A changed secret reaches the Worker on the next
deploy (`gh workflow run deploy.yml`).

## Replacement machine

Nothing runs on a personal machine: the Worker, its cron and its KV
namespace live in Cloudflare, and every secret lives in the `Calendar Feeds`
vault. A new laptop needs only a clone, `bun install` and the usual
1Password access for `just dev`. A new phone re-adds its subscriptions
(or gets them through iCloud if they were added to an iCloud calendar
account). The Google refresh token is not tied to any machine.
