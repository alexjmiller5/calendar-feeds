set shell := ["bash", "-cu"]

default:
    @just --list

# Local Worker with the real secrets injected (wrangler reads them from the process env)
dev:
    op run --env-file=.env.tpl -- env CLOUDFLARE_INCLUDE_PROCESS_ENV=true bunx wrangler dev

# Worker tests + operator script tests
test:
    bun run test
    uv run --with httpx python scripts/test_provision.py
    uv run python scripts/test_google_oauth.py

# All static analysis: wrangler types + tsc + prettier + ruff (read-only)
check:
    bun run check && bun run lint
    uvx ruff check scripts && uvx ruff format --check scripts

fmt:
    bun run format
    uvx ruff format scripts

# Stream logs from the deployed Worker
logs:
    bunx wrangler tail

# Push .env.tpl secrets to the Worker (no plaintext touches disk)
sync-secrets:
    ./scripts/sync-secrets.sh

deploy: test
    bunx wrangler deploy
