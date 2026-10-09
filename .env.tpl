# Canonical secrets manifest - 1Password secret references only, SAFE to commit.
# Every var is a field of the ONE "Calendar Feeds ENV" item in the project vault.
# Local dev:      just dev
# Push to CF:     just sync-secrets (CI does this on every deploy)

# Soma hub and this app's exact-column read token (minted by scripts/provision.py)
SOMA_HUB_URL=op://Calendar Feeds/Calendar Feeds ENV/SOMA_HUB_URL
SOMA_HUB_TOKEN=op://Calendar Feeds/Calendar Feeds ENV/SOMA_HUB_TOKEN

# One random token per feed URL (minted by scripts/provision.py)
FEED_TOKEN_TASKS=op://Calendar Feeds/Calendar Feeds ENV/FEED_TOKEN_TASKS
FEED_TOKEN_TRIPS=op://Calendar Feeds/Calendar Feeds ENV/FEED_TOKEN_TRIPS
FEED_TOKEN_EVENTS=op://Calendar Feeds/Calendar Feeds ENV/FEED_TOKEN_EVENTS

# Google push: this project's own OAuth client + refresh token (scripts/google-oauth.py).
# CHANGEME values leave the push disabled; the feeds work without them.
GOOGLE_CLIENT_ID=op://Calendar Feeds/Calendar Feeds ENV/GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=op://Calendar Feeds/Calendar Feeds ENV/GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN=op://Calendar Feeds/Calendar Feeds ENV/GOOGLE_REFRESH_TOKEN
