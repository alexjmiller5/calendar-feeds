#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Idempotent KV namespace provisioner (declarative-via-script).

wrangler.jsonc is the declaration: each `kv_namespaces` binding owns the
namespace titled `<worker name>-<binding lowercased>`. This script creates any
missing one, then reports the id wrangler.jsonc must carry. Re-running
converges; it never deletes.

  scripts/cf-kv.py                 ensure every declared namespace exists
  scripts/cf-kv.py --dry-run       print the plan, change nothing
  scripts/cf-kv.py --parse-only    just print the titles found in config

Auth: CLOUDFLARE_API_TOKEN env var if set (needs Account > Workers KV Storage: Edit), else
the AI Agent Cloudflare API key from 1Password (by ID).
Account: CLOUDFLARE_ACCOUNT_ID env var, else the token's sole visible account.
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys

import httpx

API = "https://api.cloudflare.com/client/v4"
OP_TOKEN_REF = "op://4eeyrkqibibn7k4j6rz2fbzvxm/mxxpo6neiz3grdyrjj7rv7nume/credential"


def api_token() -> str:
    if tok := os.environ.get("CLOUDFLARE_API_TOKEN"):
        return tok
    return subprocess.run(
        ["op", "read", OP_TOKEN_REF], capture_output=True, text=True, check=True
    ).stdout.strip()


def unwrap(r: httpx.Response) -> dict | list:
    r.raise_for_status()
    body = r.json()
    if not body.get("success"):
        sys.exit(f"Cloudflare API error: {body.get('errors')}")
    return body["result"]


def strip_jsonc(text: str) -> str:
    """JSONC -> JSON: drop // and /* */ comments (string-safe) + trailing commas."""
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
            out.append(ch)
        elif ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif ch == "/" and i + 1 < n and text[i + 1] == "*":
            i = text.find("*/", i + 2)
            if i == -1:
                break
            i += 2
            continue
        else:
            out.append(ch)
        i += 1
    cleaned, j = [], 0
    s = "".join(out)
    while j < len(s):
        if s[j] == ",":
            k = j + 1
            while k < len(s) and s[k] in " \t\r\n":
                k += 1
            if k < len(s) and s[k] in "}]":
                j += 1
                continue
        cleaned.append(s[j])
        j += 1
    return "".join(cleaned)


def declared(config: pathlib.Path) -> dict[str, str]:
    """namespace title -> declared id (may be a CHANGEME placeholder)."""
    cfg = json.loads(strip_jsonc(config.read_text()))
    return {
        f"{cfg['name']}-{k['binding'].lower()}": k.get("id", "")
        for k in cfg.get("kv_namespaces", [])
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--config",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent.parent / "wrangler.jsonc",
    )
    ap.add_argument(
        "--parse-only", action="store_true", help="print declared titles, no API"
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="print the plan, change nothing"
    )
    args = ap.parse_args()

    wanted = declared(args.config)
    if args.parse_only:
        print("\n".join(wanted) or "(no kv_namespaces declared)")
        return
    if not wanted:
        print(f"no kv_namespaces declared in {args.config} - nothing to do")
        return

    c = httpx.Client(headers={"Authorization": f"Bearer {api_token()}"}, timeout=30)
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        accounts = unwrap(c.get(f"{API}/accounts"))
        if len(accounts) != 1:
            sys.exit("Multiple accounts visible - set CLOUDFLARE_ACCOUNT_ID")
        account = accounts[0]["id"]

    base = f"{API}/accounts/{account}/storage/kv/namespaces"
    existing = {
        n["title"]: n["id"] for n in unwrap(c.get(base, params={"per_page": 1000}))
    }
    drift = False
    for title, declared_id in wanted.items():
        if title in existing:
            ns_id = existing[title]
            print(f"'{title}' exists ({ns_id})")
        elif args.dry_run:
            print(f"WOULD CREATE '{title}'")
            continue
        else:
            ns_id = unwrap(c.post(base, json={"title": title}))["id"]
            print(f"created '{title}' ({ns_id})")
        if declared_id != ns_id:
            drift = True
            print(
                f"  -> set the {title} id to {ns_id} in {args.config.name} (declared: {declared_id or 'none'})"
            )
    if drift:
        sys.exit(1)


if __name__ == "__main__":
    main()
