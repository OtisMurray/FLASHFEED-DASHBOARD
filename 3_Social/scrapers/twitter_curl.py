"""
Twitter/X scraper using curl_cffi impersonation (no API key needed).

Approach:
  1. Acquire a guest token from Twitter's internal API using the public bearer token
     that the Twitter web app uses (well-known, embedded in twitter.com JS).
  2. Use the GraphQL UserByScreenName + UserTweets endpoints with that guest token.

Usage:
  python scrapers/twitter_curl.py                   # test with default handles
  python scrapers/twitter_curl.py --handle Benzinga # single handle

Requirements:
  pip install curl_cffi
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

from curl_cffi.requests import Session

log = logging.getLogger(__name__)

# ── Twitter internal constants ─────────────────────────────────────────────────

# The public app-level bearer token embedded in Twitter's web JS (not a user secret)
_BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D"
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

# GraphQL query IDs — Twitter rotates these; refreshed automatically at startup
# Fallback values (may be stale; auto-refresh overrides these)
_QID_USER_BY_NAME  = "IGgvgiOx4QZndDHuD3x9TQ"
_QID_USER_TWEETS   = "FOlovQsiHGDls3c0Q_HaSQ"

_BASE = "https://twitter.com"


def _refresh_query_ids(session: Session) -> None:
    """Fetch Twitter's main JS bundle and extract up-to-date GraphQL query IDs."""
    global _QID_USER_BY_NAME, _QID_USER_TWEETS
    try:
        home = session.get(
            "https://twitter.com",
            headers={"accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9"},
        )
        js_urls = re.findall(
            r'src="(https://abs\.twimg\.com/responsive-web/client-web/main\.[a-z0-9]+\.js)"',
            home.text,
        )
        if not js_urls:
            log.debug("Could not find main JS bundle URL; using cached query IDs")
            return
        js_resp = session.get(js_urls[0], headers={"accept": "*/*", "referer": "https://twitter.com/"})
        patterns = {
            "UserTweets":         r'queryId:"([A-Za-z0-9_-]{20,})",operationName:"UserTweets"',
            "UserByScreenName":   r'queryId:"([A-Za-z0-9_-]{20,})",operationName:"UserByScreenName"',
        }
        for name, pat in patterns.items():
            m = re.search(pat, js_resp.text)
            if m:
                qid = m.group(1)
                if name == "UserTweets":
                    _QID_USER_TWEETS = qid
                elif name == "UserByScreenName":
                    _QID_USER_BY_NAME = qid
                log.debug("Refreshed %s queryId → %s", name, qid)
    except Exception as exc:
        log.debug("_refresh_query_ids: %s (using cached values)", exc)

# Standard browser headers Twitter expects
_BROWSER_HEADERS = {
    "accept":           "*/*",
    "accept-language":  "en-US,en;q=0.9",
    "accept-encoding":  "gzip, deflate, br",
    "cache-control":    "no-cache",
    "pragma":           "no-cache",
    "sec-ch-ua":        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest":   "empty",
    "sec-fetch-mode":   "cors",
    "sec-fetch-site":   "same-origin",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "referer":          "https://twitter.com/",
    "origin":           "https://twitter.com",
}


# ── Session factory ────────────────────────────────────────────────────────────

def _make_session() -> Session:
    s = Session(impersonate="chrome124", verify=True, timeout=20)
    s.headers.update(_BROWSER_HEADERS)
    s.headers["authorization"] = f"Bearer {_BEARER}"
    return s


# ── Step 1: guest token ────────────────────────────────────────────────────────

def get_guest_token(session: Session) -> Optional[str]:
    """POST to the guest/activate endpoint to get a short-lived guest token."""
    try:
        resp = session.post(
            "https://api.twitter.com/1.1/guest/activate.json",
            headers={"content-type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        data = resp.json()
        token = data.get("guest_token")
        if token:
            log.debug("Guest token acquired: %s…", token[:8])
            session.headers["x-guest-token"] = token
        return token
    except Exception as exc:
        log.error("Failed to get guest token: %s", exc)
        return None


# ── Step 2: resolve handle → user_id ──────────────────────────────────────────

def resolve_user_id(session: Session, handle: str) -> Optional[str]:
    """Use GraphQL UserByScreenName to convert a handle to a numeric user ID."""
    variables = json.dumps({
        "screen_name": handle,
        "withSafetyModeUserFields": True,
    })
    features = json.dumps({
        "hidden_profile_likes_enabled": True,
        "hidden_profile_subscriptions_enabled": True,
        "responsive_web_graphql_exclude_directive_enabled": True,
        "verified_phone_label_enabled": False,
        "subscriptions_verification_info_is_identity_verified_enabled": True,
        "subscriptions_verification_info_verified_since_enabled": True,
        "highlights_tweets_tab_ui_enabled": True,
        "responsive_web_twitter_article_notes_tab_enabled": False,
        "creator_subscriptions_tweet_preview_api_enabled": True,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
        "responsive_web_graphql_timeline_navigation_enabled": True,
    })
    try:
        url = (
            f"{_BASE}/i/api/graphql/{_QID_USER_BY_NAME}/UserByScreenName"
            f"?variables={urllib.parse.quote(variables)}"
            f"&features={urllib.parse.quote(features)}"
        )
        resp = session.get(url)
        resp.raise_for_status()
        data = resp.json()
        user_id = (
            data.get("data", {})
                .get("user", {})
                .get("result", {})
                .get("rest_id")
        )
        if user_id:
            log.debug("@%s → user_id %s", handle, user_id)
        return user_id
    except Exception as exc:
        log.warning("resolve_user_id @%s failed: %s", handle, exc)
        return None


# ── Step 3: fetch tweets ───────────────────────────────────────────────────────

def fetch_user_tweets(session: Session, user_id: str, count: int = 20) -> list[dict]:
    """Fetch recent tweets for a user_id via the GraphQL UserTweets endpoint."""
    variables = json.dumps({
        "userId": user_id,
        "count": count,
        "includePromotedContent": False,
        "withQuickPromoteEligibilityTweetFields": True,
        "withVoice": True,
        "withV2Timeline": True,
    })
    features = json.dumps({
        "rweb_lists_timeline_redesign_enabled": True,
        "responsive_web_graphql_exclude_directive_enabled": True,
        "verified_phone_label_enabled": False,
        "creator_subscriptions_tweet_preview_api_enabled": True,
        "responsive_web_graphql_timeline_navigation_enabled": True,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
        "tweetypie_unmention_optimization_enabled": True,
        "responsive_web_edit_tweet_api_enabled": True,
        "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
        "view_counts_everywhere_api_enabled": True,
        "longform_notetweets_consumption_enabled": True,
        "responsive_web_twitter_article_tweet_consumption_enabled": False,
        "tweet_awards_web_tipping_enabled": False,
        "freedom_of_speech_not_reach_fetch_enabled": True,
        "standardized_nudges_misinfo": True,
        "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
        "longform_notetweets_rich_text_read_enabled": True,
        "longform_notetweets_inline_media_enabled": True,
        "responsive_web_enhance_cards_enabled": False,
    })
    try:
        url = (
            f"{_BASE}/i/api/graphql/{_QID_USER_TWEETS}/UserTweets"
            f"?variables={urllib.parse.quote(variables)}"
            f"&features={urllib.parse.quote(features)}"
        )
        resp = session.get(url)
        resp.raise_for_status()
        data = resp.json()
        return _parse_tweets(data, user_id)
    except Exception as exc:
        log.warning("fetch_user_tweets %s failed: %s", user_id, exc)
        return []


def _parse_tweets(data: dict, user_id: str) -> list[dict]:
    """Walk the GraphQL timeline response and extract tweet objects."""
    tweets: list[dict] = []
    try:
        result = data.get("data", {}).get("user", {}).get("result", {})
        # API returns either "timeline_v2" or "timeline" depending on features flags
        timeline_root = result.get("timeline_v2") or result.get("timeline") or {}
        instructions = timeline_root.get("timeline", {}).get("instructions", [])
        for instruction in instructions:
            entries = instruction.get("entries", [])
            for entry in entries:
                content = entry.get("content", {})
                item_content = content.get("itemContent", {})
                tweet_result = item_content.get("tweet_results", {}).get("result", {})
                tweet = tweet_result.get("legacy", {})
                if not tweet:
                    continue
                text = tweet.get("full_text", "").strip()
                if not text or text.startswith("RT @"):
                    continue  # skip retweets
                created = tweet.get("created_at", "")
                try:
                    published_at = datetime.strptime(
                        created, "%a %b %d %H:%M:%S %z %Y"
                    )
                except Exception:
                    published_at = datetime.now(timezone.utc)

                # Get the screen_name — newer API puts it in user_results.result.core,
                # older format had it in user_results.result.legacy
                user_result = (
                    tweet_result.get("core", {})
                                .get("user_results", {})
                                .get("result", {})
                )
                author = (
                    user_result.get("core", {}).get("screen_name")
                    or user_result.get("legacy", {}).get("screen_name")
                    or "unknown"
                )
                tweet_id = tweet.get("id_str", "")
                tweets.append({
                    "id":           tweet_id or hashlib.sha1(text[:80].encode()).hexdigest()[:16],
                    "source":       "twitter",
                    "author":       f"@{author}",
                    "title":        text[:200],
                    "text":         text,
                    "url":          f"https://x.com/{author}/status/{tweet_id}" if tweet_id else f"https://x.com/{author}",
                    "published_at": published_at,
                    "scraped_at":   datetime.now(timezone.utc),
                    "likes":        tweet.get("favorite_count", 0),
                    "retweets":     tweet.get("retweet_count", 0),
                    "tickers_mentioned": [],
                    "is_processed": False,
                    "is_scored":    False,
                    "is_duplicate": False,
                    "is_rumor":     False,
                })
    except Exception as exc:
        log.warning("_parse_tweets error: %s", exc)
    return tweets


# ── Public API ─────────────────────────────────────────────────────────────────

def scrape_handle(handle: str, count: int = 20, _session: Optional[Session] = None) -> list[dict]:
    """Full flow: session → guest token → user_id → tweets for one handle.

    Pass an existing `_session` (already authenticated with a guest token) to
    avoid re-fetching query IDs and guest tokens on every call when scraping
    many handles in a loop.
    """
    session = _session or _make_session()

    if _session is None:
        # Fresh session: auto-refresh query IDs from current JS bundle
        _refresh_query_ids(session)

    token = get_guest_token(session)
    if not token:
        log.error("@%s: could not acquire guest token", handle)
        return []

    user_id = resolve_user_id(session, handle)
    if not user_id:
        log.error("@%s: could not resolve user_id", handle)
        return []

    tweets = fetch_user_tweets(session, user_id, count=count)
    log.info("@%-20s  %d tweets", handle, len(tweets))
    return tweets


# Default financial handles to scrape
DEFAULT_HANDLES = [
    "Benzinga", "unusual_whales", "ewhispers", "DeItaone",
    "FirstSquawk", "LiveSquawk", "MarketWatch", "WSJ",
    "Reuters", "Investingcom", "StockMKTNewz", "realwillmeade",
    "zerohedge", "BreakingMarkets", "CNBC",
]


def scrape_all(handles: Optional[list[str]] = None, count: int = 20, delay: float = 2.0) -> list[dict]:
    """Scrape multiple handles in one session, returning all collected tweets.

    Refreshes query IDs once at the top and acquires one guest token per handle
    (Twitter guest tokens are per-request, not shared).
    """
    if handles is None:
        handles = DEFAULT_HANDLES

    # Build a session and refresh query IDs once
    session = _make_session()
    _refresh_query_ids(session)

    all_tweets: list[dict] = []
    for handle in handles:
        tweets = scrape_handle(handle, count=count, _session=session)
        all_tweets.extend(tweets)
        if delay > 0:
            time.sleep(delay)

    log.info("scrape_all: %d handles → %d tweets", len(handles), len(all_tweets))
    return all_tweets


# ── CLI test ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import warnings
    warnings.filterwarnings("ignore")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
    )

    parser = argparse.ArgumentParser(description="Test Twitter curl-impersonate scraper")
    parser.add_argument("--handle", default="Benzinga", help="Twitter handle to test")
    parser.add_argument("--count",  type=int, default=10, help="Number of tweets to fetch")
    parser.add_argument("--all",    action="store_true", help="Scrape all default finance handles")
    args = parser.parse_args()

    if args.all:
        print(f"\nScraping all {len(DEFAULT_HANDLES)} default handles …\n")
        tweets = scrape_all(count=args.count)
    else:
        print(f"\nScraping @{args.handle} …\n")
        tweets = scrape_handle(args.handle, count=args.count)

    if not tweets:
        print("No tweets fetched.")
    else:
        for t in tweets:
            dt = t["published_at"].strftime("%Y-%m-%d %H:%M") if isinstance(t["published_at"], datetime) else str(t["published_at"])
            print(f"  [{dt}] {t['author']}: {t['text'][:120]}")
        print(f"\nTotal: {len(tweets)} tweets")
