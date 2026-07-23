from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().with_name("fetch_finviz_elite_to_mongo.py")
SPEC = importlib.util.spec_from_file_location("fetch_finviz_elite_to_mongo_tested", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    status_code = 200
    text = (
        "Ticker,Company,Sector,Industry,Country,Market Cap,RSI (14),"
        "Average Volume,Relative Volume,Volume,Price,Change\n"
        "TEST,Test Inc,Technology,Software,USA,100M,55,1M,3.2,500000,4.25,12.5%\n"
    )


class FakeCollection:
    def __init__(self):
        self.update = None
        self.indexes = []

    def update_one(self, selector, update, upsert=False):
        self.update = (selector, update, upsert)

    def create_index(self, keys):
        self.indexes.append(keys)


class FakeDb:
    def __init__(self):
        self.collection = FakeCollection()

    def __getitem__(self, name):
        if name != "finviz_momentum_snapshots":
            raise KeyError(name)
        return self.collection


class FinvizIngestionTests(unittest.TestCase):
    def test_cookie_only_auto_auth_fetches_elite_rows(self):
        with mock.patch.multiple(
            MODULE,
            AUTO_AUTH_CONFIGURED=True,
            AUTH_TOKEN="",
            FINVIZ_COOKIE="",
            _new_session=mock.Mock(return_value=object()),
            _attach_auto_auth=mock.Mock(return_value=True),
            _session_get=mock.Mock(return_value=FakeResponse()),
        ):
            tier, rows, error = MODULE._fetch_tier("small", "cap_small")
        self.assertEqual(tier, "small")
        self.assertIsNone(error)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["finviz_auth_mode"], "auto_login_cookie")
        self.assertEqual(rows[0]["ticker"], "TEST")

    def test_snapshot_is_minute_keyed_ranked_and_real(self):
        db = FakeDb()
        rows = [
            {"ticker": "LOW", "price": 2.0, "change_pct": 2.5, "volume": 1000},
            {"ticker": "HIGH", "price": 3.0, "change_pct": 9.5, "volume": 2000},
        ]
        with mock.patch.object(MODULE.time, "time", return_value=1_800_000_061):
            count = MODULE._persist_momentum_snapshot(db, rows, "auto_login_cookie")
        selector, update, upsert = db.collection.update
        doc = update["$set"]
        self.assertEqual(count, 2)
        self.assertEqual(selector["_id"], "finviz_momentum:1800000060")
        self.assertTrue(upsert)
        self.assertEqual([row["ticker"] for row in doc["rows"]], ["HIGH", "LOW"])
        self.assertEqual([row["rank"] for row in doc["rows"]], [1, 2])
        self.assertEqual(doc["auth_mode"], "auto_login_cookie")


if __name__ == "__main__":
    unittest.main()
