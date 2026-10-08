"""Run with `uv run --with httpx python scripts/test_provision.py`. No credentials."""

import json
import os
import pathlib
import re
import subprocess
import unittest
from contextlib import contextmanager
from unittest.mock import patch

import httpx
import provision


@contextmanager
def provider(accounts, account=""):
    requests = []
    client = httpx.Client

    def respond(request):
        requests.append(request)
        if request.method == "DELETE":
            raise AssertionError("Provisioning must preserve the working token")
        if request.url.path.endswith("/accounts"):
            result = [{"id": value} for value in accounts]
        elif request.url.path.endswith("permission_groups"):
            result = [
                {"name": name, "id": name}
                for name in [
                    "Workers Scripts Write",
                    "Workers R2 Storage Write",
                    "D1 Write",
                ]
            ]
        elif request.method == "POST":
            result = {"id": "new-id", "value": "fixture-token"}
        else:
            result = [{"id": "working-id", "name": provision.NAME + "-deploy"}]
        return httpx.Response(200, json={"success": True, "result": result})

    env = {"CF_PROVISION_TOKEN": "fixture-admin"}
    if account:
        env["CLOUDFLARE_ACCOUNT_ID"] = account
    with (
        patch.dict(os.environ, env, clear=True),
        patch.object(provision, "op_read", return_value="fixture-admin") as read,
        patch.object(
            provision.httpx,
            "Client",
            side_effect=lambda **kwargs: client(
                transport=httpx.MockTransport(respond), **kwargs
            ),
        ),
    ):
        yield requests, read


class ProvisionTest(unittest.TestCase):
    def test_replacements_preserve_working_token_and_only_grant_script_writes(self):
        with provider([], "selected-account") as (requests, read):
            self.assertEqual(provision.mint_deploy_token(), "fixture-token")
            self.assertEqual(provision.mint_deploy_token(), "fixture-token")
            read.assert_not_called()
        bodies = [json.loads(r.content) for r in requests if r.method == "POST"]
        self.assertEqual(len(bodies), 2)
        self.assertNotEqual(bodies[0]["name"], bodies[1]["name"])
        for body in bodies:
            self.assertEqual(
                body["policies"],
                [
                    {
                        "effect": "allow",
                        "resources": {
                            "com.cloudflare.api.account.selected-account": "*"
                        },
                        "permission_groups": [{"id": "Workers Scripts Write"}],
                    }
                ],
            )
        self.assertFalse(any(r.url.path.endswith("/accounts") for r in requests))

    def test_account_field_and_mint_discover_the_same_single_account(self):
        with provider(["discovered-account"]) as (requests, _):
            self.assertEqual(provision.MINTERS["account-id"](), "discovered-account")
            provision.mint_deploy_token()
        body = json.loads(next(r.content for r in requests if r.method == "POST"))
        self.assertEqual(
            body["policies"][0]["resources"],
            {
                "com.cloudflare.api.account.discovered-account": "*",
            },
        )

    def test_ambiguous_or_missing_account_cannot_mint(self):
        for accounts in ([], ["first", "second"]):
            with self.subTest(accounts=accounts), provider(accounts) as (requests, _):
                with self.assertRaisesRegex(RuntimeError, "CLOUDFLARE_ACCOUNT_ID"):
                    provision.mint_deploy_token()
                self.assertFalse(any(r.method == "POST" for r in requests))


class AppSecretsTest(unittest.TestCase):
    def test_every_env_field_is_mintable(self):
        self.assertTrue(
            {
                "FEED_TOKEN_TASKS",
                "FEED_TOKEN_TRIPS",
                "FEED_TOKEN_EVENTS",
                "LIFE_HUB_URL",
                "LIFE_HUB_TOKEN",
            }
            <= set(provision.FIELDS)
        )

    def test_feed_tokens_are_long_and_random(self):
        values = {provision.MINTERS["FEED_TOKEN_TASKS"]() for _ in range(3)}
        self.assertEqual(len(values), 3)
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_-]{43,}", v) for v in values))

    def test_hub_url_comes_from_the_operator_environment(self):
        with patch.dict(
            os.environ, {"LIFE_HUB_URL": "https://hub.example"}, clear=True
        ):
            self.assertEqual(provision.MINTERS["LIFE_HUB_URL"](), "https://hub.example")
        with (
            patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(RuntimeError, "LIFE_HUB_URL"),
        ):
            provision.MINTERS["LIFE_HUB_URL"]()

    def test_hub_token_is_a_new_exact_column_read_grant(self):
        done = subprocess.CompletedProcess(
            [], 0, stdout=json.dumps({"token": "lt_fixture"})
        )
        with patch.object(provision.subprocess, "run", return_value=done) as run:
            self.assertEqual(provision.MINTERS["LIFE_HUB_TOKEN"](), "lt_fixture")
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ["life", "token", "create"])
        self.assertRegex(args[3], r"^calendar-feeds-[0-9a-f]{8}$")
        self.assertEqual(args[4:], ["--scopes", provision.SCOPES])
        self.assertTrue(
            all(
                s.startswith("tables:read:") and s.count(":") == 3
                for s in provision.SCOPES.split(",")
            )
        )

    def test_scopes_match_the_worker_columns(self):
        source = (pathlib.Path(__file__).parent.parent / "src/index.ts").read_text()
        feeds = re.findall(r"table: '(\w+)',\s*columns: \[([^\]]*)\]", source)
        self.assertEqual(len(feeds), 3)
        expected = [
            f"tables:read:{table}:{col}"
            for table, cols in feeds
            for col in re.findall(r"'(\w+)'", cols)
        ]
        self.assertEqual(provision.SCOPES.split(","), expected)


if __name__ == "__main__":
    unittest.main()
