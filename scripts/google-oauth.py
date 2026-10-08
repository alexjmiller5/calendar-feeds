#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""One-time Google consent for the Calendar Feeds push.

  scripts/google-oauth.py <oauth-client.json>

Takes the OAuth client JSON downloaded from Google Cloud (Desktop app type),
opens the browser consent page for the calendar.app.created scope (the app
can only see calendars it created), and prints the three values the Worker
needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
Run it on a machine with a browser; nothing is written to disk.
"""

import base64
import hashlib
import json
import secrets
import sys
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

SCOPE = "https://www.googleapis.com/auth/calendar.app.created"
AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"


def load_client(path: str) -> tuple[str, str]:
    data = json.loads(Path(path).read_text())
    client = data.get("installed") or data.get("web") or data
    return client["client_id"], client["client_secret"]


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


def consent_url(client_id: str, redirect: str, challenge: str, state: str) -> str:
    return (
        AUTH
        + "?"
        + urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect,
                "response_type": "code",
                "scope": SCOPE,
                "access_type": "offline",
                "prompt": "consent",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": state,
            }
        )
    )


def wait_for_code(server: HTTPServer, state: str) -> str:
    result: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            query = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
            if query.get("state") == state and "code" in query:
                result["code"] = query["code"]
                message = "Calendar Feeds is authorized. You can close this tab."
            else:
                result["error"] = query.get("error", "state mismatch")
                message = "Authorization failed: " + result["error"]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(message.encode())

        def log_message(self, *args):
            pass

    server.RequestHandlerClass = Handler
    while not result:
        server.handle_request()
    if "code" not in result:
        sys.exit("Google consent failed: " + result["error"])
    return result["code"]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    client_id, client_secret = load_client(sys.argv[1])
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(16)
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    redirect = f"http://127.0.0.1:{server.server_port}/"
    url = consent_url(client_id, redirect, challenge, state)
    print("Opening the Google consent page:\n" + url, file=sys.stderr)
    webbrowser.open(url)
    code = wait_for_code(server, state)
    body = urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        }
    ).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN, data=body)) as res:
        tokens = json.load(res)
    if "refresh_token" not in tokens:
        sys.exit(
            "Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and rerun"
        )
    print(f"GOOGLE_CLIENT_ID={client_id}")
    print(f"GOOGLE_CLIENT_SECRET={client_secret}")
    print(f"GOOGLE_REFRESH_TOKEN={tokens['refresh_token']}")


if __name__ == "__main__":
    main()
