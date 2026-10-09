# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Bootstrap minting: --list or --field NAME. Secret output is for the caller.

The provisioning credential only mints replacements. Save the new value,
deploy and verify before retiring the previous token by its provider ID.

SOMA_HUB_URL and SOMA_HUB_TOKEN need the `soma` CLI to run with operator
authority (its usual SOMA_HUB_URL / SOMA_HUB_TOKEN environment).
"""

import json
import os
import secrets
import subprocess
import sys
from uuid import uuid4

import httpx

NAME = "calendar-feeds"
OP_CF_TOKEN = "op://4eeyrkqibibn7k4j6rz2fbzvxm/mxxpo6neiz3grdyrjj7rv7nume/credential"
FEED_TOKENS = ["FEED_TOKEN_TASKS", "FEED_TOKEN_TRIPS", "FEED_TOKEN_EVENTS"]
FIELDS = ["api-token", "account-id", "SOMA_HUB_URL", "SOMA_HUB_TOKEN", *FEED_TOKENS]
# Exactly the columns the Worker reads (FEEDS in src/index.ts; a test keeps them equal).
COLUMNS = {
    "tasks": ["id", "title", "status", "due_date", "updated_at", "deleted_at"],
    "trips": [
        "id",
        "name",
        "status",
        "start_on",
        "end_on",
        "cities",
        "countries",
        "updated_at",
        "deleted_at",
    ],
    "calendar_events": [
        "id",
        "title",
        "status",
        "date",
        "start_at",
        "end_at",
        "updated_at",
        "deleted_at",
    ],
}
SCOPES = ",".join(
    f"tables:read:{table}:{col}" for table, cols in COLUMNS.items() for col in cols
)


def log(message: str) -> None:
    print(message, file=sys.stderr)


def op_read(ref: str) -> str:
    return subprocess.run(
        ["op", "read", ref], capture_output=True, text=True, check=True
    ).stdout.strip()


def client() -> httpx.Client:
    return httpx.Client(
        base_url="https://api.cloudflare.com/client/v4",
        headers={
            "Authorization": "Bearer "
            + (os.environ.get("CF_PROVISION_TOKEN") or op_read(OP_CF_TOKEN))
        },
        timeout=30,
    )


def account_id(c: httpx.Client) -> str:
    if value := os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        return value
    accounts = c.get("/accounts").raise_for_status().json()["result"]
    if len(accounts) != 1:
        raise RuntimeError("Set CLOUDFLARE_ACCOUNT_ID to select the deployment account")
    return accounts[0]["id"]


def mint_deploy_token() -> str:
    """Dedicated credential; Workers Scripts Write is account-wide in Cloudflare."""
    with client() as c:
        groups = (
            c.get("/user/tokens/permission_groups").raise_for_status().json()["result"]
        )
        ids = {g["name"]: g["id"] for g in groups}
        policies = [
            {
                "effect": "allow",
                "resources": {f"com.cloudflare.api.account.{account_id(c)}": "*"},
                "permission_groups": [{"id": ids["Workers Scripts Write"]}],
            }
        ]
        result = (
            c.post(
                "/user/tokens",
                json={
                    "name": f"{NAME}-deploy-{uuid4().hex[:8]}",
                    "policies": policies,
                },
            )
            .raise_for_status()
            .json()
        )
        if not result.get("success"):
            raise RuntimeError("Cloudflare refused the deployment credential")
        log(
            f"Minted deployment token {result['result']['id']}; previous tokens remain active until verification"
        )
        return result["result"]["value"]


def deployment_account() -> str:
    with client() as c:
        return account_id(c)


def hub_url() -> str:
    if value := os.environ.get("SOMA_HUB_URL"):
        return value
    raise RuntimeError("Set SOMA_HUB_URL to the Soma hub the Worker reads")


def mint_hub_token() -> str:
    """A new, separately revocable token per mint; earlier ones stay active until retired."""
    name = f"{NAME}-{uuid4().hex[:8]}"
    out = subprocess.run(
        ["soma", "token", "create", name, "--scopes", SCOPES],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    log(f"Minted Soma token {name}")
    return json.loads(out)["token"]


MINTERS = {
    "api-token": mint_deploy_token,
    "account-id": deployment_account,
    "SOMA_HUB_URL": hub_url,
    "SOMA_HUB_TOKEN": mint_hub_token,
    **{field: lambda: secrets.token_urlsafe(32) for field in FEED_TOKENS},
}


def main() -> None:
    if sys.argv[1:] == ["--list"]:
        print("\n".join(FIELDS))
    elif len(sys.argv) == 3 and sys.argv[1] == "--field" and sys.argv[2] in FIELDS:
        print(MINTERS[sys.argv[2]]())
    else:
        sys.exit(f"usage: provision.py --list | --field {{{','.join(FIELDS)}}}")


if __name__ == "__main__":
    main()
