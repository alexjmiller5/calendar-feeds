"""Run with `uv run python scripts/test_google_oauth.py`. No network, no browser."""

import base64
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location(
    "google_oauth", pathlib.Path(__file__).parent / "google-oauth.py"
)
oauth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oauth)


class GoogleOAuthTest(unittest.TestCase):
    def test_reads_desktop_and_web_client_files(self):
        for kind in ("installed", "web"):
            with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
                json.dump({kind: {"client_id": "id", "client_secret": "secret"}}, f)
                f.flush()
                self.assertEqual(oauth.load_client(f.name), ("id", "secret"))

    def test_pkce_challenge_is_the_s256_of_the_verifier(self):
        verifier, challenge = oauth.pkce()
        digest = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        self.assertEqual(challenge, digest)
        self.assertGreaterEqual(len(verifier), 43)

    def test_consent_url_asks_offline_for_app_created_calendars_only(self):
        url = oauth.consent_url("id", "http://127.0.0.1:5000/", "challenge", "state")
        query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        self.assertEqual(
            query,
            {
                "client_id": "id",
                "redirect_uri": "http://127.0.0.1:5000/",
                "response_type": "code",
                "scope": "https://www.googleapis.com/auth/calendar.app.created",
                "access_type": "offline",
                "prompt": "consent",
                "code_challenge": "challenge",
                "code_challenge_method": "S256",
                "state": "state",
            },
        )


if __name__ == "__main__":
    unittest.main()
