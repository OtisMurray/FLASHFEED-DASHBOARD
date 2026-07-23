from __future__ import annotations

import importlib
import json
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


MODULE_DIR = Path(__file__).resolve().parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))


class FakeCookies:
    def __init__(self):
        self.values = {}

    def set(self, name, value, domain=None):
        self.values[(name, domain)] = value

    def update(self, values):
        self.values.update(values)


class FakeSession:
    def __init__(self):
        self.cookies = FakeCookies()


class FakeExportSession:
    def __init__(self, status_code=200, text='"No.","Ticker","Company"\n1,"AAPL","Apple Inc"\n'):
        self.status_code = status_code
        self.text = text
        self.requested_url = None

    def get(self, url, **_kwargs):
        self.requested_url = url
        return self


class FinvizAuthTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(
            os.environ,
            {"VAR_ROOT": self.tempdir.name, "FINVIZ_LOGIN": "", "FINVIZ_PASSWORD": ""},
            clear=False,
        )
        self.env.start()
        import finviz_auth
        self.auth = importlib.reload(finviz_auth)

    def tearDown(self):
        self.env.stop()
        self.tempdir.cleanup()

    def test_login_requires_both_environment_values(self):
        self.assertFalse(self.auth.have_login())
        with mock.patch.dict(os.environ, {"FINVIZ_LOGIN": "configured", "FINVIZ_PASSWORD": "configured"}):
            self.assertTrue(self.auth.have_login())

    def test_persisted_cookie_is_private_and_loadable(self):
        payload = {
            "cookies": {".ASPXAUTH": "session-value"},
            "expires": time.time() + 7200,
            "saved": time.time(),
        }
        self.auth._persist_cookies(payload)
        mode = stat.S_IMODE(self.auth._COOKIE_PATH.stat().st_mode)
        self.assertEqual(mode, 0o600)
        session = FakeSession()
        self.assertTrue(self.auth.load_cookies_into(session, auto_login=False))
        self.assertEqual(session.cookies.values[(".ASPXAUTH", ".finviz.com")], "session-value")

    def test_force_refresh_adopts_cookie_created_by_waiting_peer(self):
        peer_payload = {
            "cookies": {".ASPXAUTH": "peer-session"},
            "expires": time.time() + 7200,
            "saved": time.time() + 1,
        }
        self.auth._VAR_DIR.mkdir(parents=True, exist_ok=True)
        self.auth._COOKIE_PATH.write_text(json.dumps(peer_payload), encoding="utf-8")
        with mock.patch.object(self.auth, "_login") as login:
            result = self.auth.refresh(force=True)
        login.assert_not_called()
        self.assertEqual(result["cookies"][".ASPXAUTH"], "peer-session")

    def test_cookie_probe_uses_small_single_ticker_export(self):
        session = FakeExportSession()
        self.assertTrue(self.auth._cookie_session_works(session))
        self.assertIn("export.ashx", session.requested_url)
        self.assertNotIn("quote_export", session.requested_url)
        self.assertFalse(self.auth._cookie_session_works(FakeExportSession(status_code=401, text="Unauthorized")))


if __name__ == "__main__":
    unittest.main()
