"""Shared pytest fixtures for the DS440 scraper test suite.

Uses ``mongomock`` so tests run without a real MongoDB instance.
Uses ``fakeredis`` so Redis tests run without a real Redis instance.
"""

import fakeredis
import mongomock
import pytest

from scrapers.db import ensure_indexes


@pytest.fixture()
def mongo_collection():
    """Return a mongomock Collection with all pipeline indexes applied."""
    client = mongomock.MongoClient()
    collection = client["ds440_test"]["posts"]
    ensure_indexes(collection)
    return collection


@pytest.fixture()
def windows_collection():
    """Return a mongomock Collection for rolling windows."""
    client = mongomock.MongoClient()
    return client["ds440_test"]["rolling_windows"]


@pytest.fixture()
def finviz_collection():
    """Return a mongomock Collection for Finviz screener data."""
    client = mongomock.MongoClient()
    return client["ds440_test"]["finviz_screener"]


@pytest.fixture()
def fake_redis():
    """Return a fakeredis client with decode_responses enabled."""
    return fakeredis.FakeRedis(decode_responses=True)
