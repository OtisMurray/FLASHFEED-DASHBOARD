"""
Keyword Pre-Filter
──────────────────
Filters RSS articles and Stocktwits posts so only content that explicitly
mentions at least one active Finviz ticker reaches Claude.

Matching formats caught per ticker:
  $GME              — dollar-prefixed cashtag
  GME               — bare uppercase symbol (word-boundary)
  (GME)             — parenthesised symbol
  NYSE: GME         — exchange-prefixed  (NYSE / NASDAQ / AMEX / OTC / NYSEARCA)
  NASDAQ:GME        — exchange-prefixed, no space
  GameStop Corp     — full company name (significant portion, ≥5 chars)
  GameStop          — first word of company name (≥5 chars)

Short tickers (1–2 chars, e.g. "F", "GM") are only matched via the cashtag
and exchange-prefix formats to avoid swamping on common words.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple

# ─── COMMON COMPANY-NAME SUFFIXES TO STRIP ────────────────────────────────────
_SUFFIX_RE = re.compile(
    r"\s+(?:Corp\.?|Corporation|Inc\.?|Incorporated|Ltd\.?|Limited|"
    r"LLC|LP|LLP|PLC|SA|NV|AG|SE|Holdings?|Group|Co\.?|Company|"
    r"Technologies?|Sciences?|Pharmaceuticals?|Therapeutics?|Bancorp|"
    r"Bancshares?|Financial|Services?|Solutions?|Systems?|Networks?|"
    r"International|Global|Industries|Industries?|Partners?|Capital|"
    r"Ventures?|Enterprises?|Brands?|Resources?|Energy|Properties)$",
    re.IGNORECASE,
)

_EXCHANGE_PREFIX = r"(?:NYSE(?:ARCA|MKT)?|NASDAQ|AMEX|OTC(?:BB|PK)?|NYSEMKT)"


# ─── PATTERN BUILDER ─────────────────────────────────────────────────────────

class TickerPatterns(NamedTuple):
    ticker:   str
    company:  str
    patterns: list[re.Pattern]
    strong_count: int = 0   # first N patterns are symbol-based (cashtag/parens/exchange/bare);
                            # the rest are company-name patterns (weaker signal)


def _build_patterns(ticker: str, company: str = "") -> TickerPatterns:
    """
    Compile all regex patterns for one ticker + company name pair.
    Short tickers (≤2 chars) skip the bare-word pattern to avoid false positives.
    """
    t = re.escape(ticker.upper())
    pats: list[re.Pattern] = []

    # 1. $GME  (cashtag — always included)
    pats.append(re.compile(rf"\${t}\b"))

    # 2. (GME)
    pats.append(re.compile(rf"\({t}\)"))

    # 3. NYSE: GME  /  NASDAQ:GME  (with or without space)
    pats.append(re.compile(rf"{_EXCHANGE_PREFIX}[:\s]+{t}\b", re.IGNORECASE))

    # 4. Bare symbol word-boundary — only for tickers ≥3 chars
    #    Require all-uppercase context to reduce false positives on common words
    if len(ticker) >= 3:
        pats.append(re.compile(rf"\b{t}\b"))

    strong_count = len(pats)   # everything so far is a symbol-based match

    # 5. Company name matching — only if name is long enough
    if company and len(company.strip()) >= 5:
        # Strip trailing legal suffixes to get the "brand" portion
        brand = _SUFFIX_RE.sub("", company.strip()).strip()

        # Full brand name (e.g. "GameStop" or "Apple")
        if len(brand) >= 5:
            pats.append(re.compile(rf"\b{re.escape(brand)}\b", re.IGNORECASE))

        # If brand has multiple words, also match the first significant word alone
        # (e.g. "GameStop" from "GameStop Corp" is already caught above)
        first_word = brand.split()[0] if brand else ""
        if len(first_word) >= 5 and first_word.lower() not in _COMMON_WORDS:
            pats.append(re.compile(rf"\b{re.escape(first_word)}\b", re.IGNORECASE))

    return TickerPatterns(ticker=ticker, company=company, patterns=pats,
                          strong_count=strong_count)


# Words common enough that matching them as company names would cause noise
_COMMON_WORDS = {
    "first", "second", "third", "american", "national", "general", "united",
    "global", "digital", "advanced", "western", "eastern", "northern", "southern",
    "pacific", "atlantic", "central", "premier", "prime", "ultra", "super",
    "power", "energy", "capital", "group", "trust", "equity", "media",
    "health", "care", "life", "smart", "clear", "rapid", "swift",
    "international", "union", "standard", "federal", "century", "liberty",
    "summit", "pioneer", "sterling", "crown", "realty", "royal",
}


# ─── TEXT MATCHING HELPER ─────────────────────────────────────────────────────

def _text_match_keyword(text: str, tp: TickerPatterns) -> str | None:
    """
    Return the literal keyword that matched *text* for *tp*
    (e.g. "$NVDA", "(GME)", "Nvidia"), or None if nothing matched.
    """
    for pat in tp.patterns:
        m = pat.search(text)
        if m:
            return m.group(0)
    return None


def _text_matches(text: str, tp: TickerPatterns) -> bool:
    """Return True if *text* contains any pattern for *tp*."""
    return _text_match_keyword(text, tp) is not None


def _any_ticker_mentioned(text: str, all_tp: list[TickerPatterns]) -> tuple[bool, str | None, str | None]:
    """
    Check whether *text* mentions any ticker in *all_tp*.
    Returns (matched, first_matched_ticker, matched_keyword) where
    matched_keyword is the literal text that triggered the match.

    Two passes: exact symbol matches ($GME, (GME), NYSE: GME, bare GME) for
    ANY ticker win over company-name matches, which are weaker signal.
    """
    # Pass 1 — symbol-based patterns only
    for tp in all_tp:
        for pat in tp.patterns[:tp.strong_count]:
            m = pat.search(text)
            if m:
                return True, tp.ticker, m.group(0)
    # Pass 2 — company-name patterns
    for tp in all_tp:
        for pat in tp.patterns[tp.strong_count:]:
            m = pat.search(text)
            if m:
                return True, tp.ticker, m.group(0)
    return False, None, None


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

class FilterStats(NamedTuple):
    label:    str    # e.g. "RSS" or "SPOT Stocktwits"
    before:   int
    after:    int

    @property
    def dropped(self) -> int:
        return self.before - self.after

    def __str__(self) -> str:
        pct = (self.dropped / self.before * 100) if self.before else 0
        return (
            f"{self.label}: {self.before} → {self.after} "
            f"(dropped {self.dropped}, {pct:.0f}% noise removed)"
        )


def build_ticker_patterns(tickers: list[dict]) -> list[TickerPatterns]:
    """
    Build compiled pattern sets for every ticker in the Finviz list.
    Each item needs at least {"ticker": "GME", "company": "GameStop Corp"}.
    """
    return [
        _build_patterns(s["ticker"], s.get("company", ""))
        for s in tickers
        if s.get("ticker")
    ]


USER_KEYWORDS_PATH = Path(__file__).parent / "user_keywords.txt"


def load_user_keywords(path: Path = USER_KEYWORDS_PATH) -> list[str]:
    """User-entered keyword dictionary (one per line, # comments allowed),
    maintained from the dashboard's Settings → Keywords panel."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    return [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]


def match_user_keyword(text: str, keywords: list[str]) -> str | None:
    """Return the first user keyword found in *text* (case-insensitive,
    word-boundary for alphanumeric keywords), or None."""
    for kw in keywords:
        if re.search(rf"(?<!\w){re.escape(kw)}(?!\w)", text, re.IGNORECASE):
            return kw
    return None


def filter_rss_articles(
    articles: list[dict],
    ticker_patterns: list[TickerPatterns],
    user_keywords: list[str] | None = None,
) -> tuple[list[dict], FilterStats]:
    """
    Keep only RSS articles whose title+description mentions at least one
    active Finviz ticker OR one user-entered keyword.  Tags each kept
    article with which ticker matched (``article["matched_ticker"]``) and
    the literal keyword that triggered the match (``matched_keyword``).

    Returns (filtered_articles, FilterStats).
    """
    user_keywords = user_keywords or []
    kept: list[dict] = []
    for article in articles:
        haystack = " ".join(filter(None, [
            article.get("title", ""),
            article.get("description", ""),
        ]))
        matched, ticker, keyword = _any_ticker_mentioned(haystack, ticker_patterns)
        if not matched and user_keywords:
            user_kw = match_user_keyword(haystack, user_keywords)
            if user_kw:
                matched, ticker, keyword = True, None, user_kw
        if matched:
            article = dict(article)          # don't mutate the original
            article["matched_ticker"] = ticker
            article["matched_keyword"] = keyword
            kept.append(article)

    return kept, FilterStats("RSS", len(articles), len(kept))


def filter_stocktwits_posts(
    posts: list[dict],
    ticker: str,
    company: str = "",
) -> tuple[list[dict], FilterStats]:
    """
    Keep only Stocktwits posts that explicitly mention *ticker* (or its
    company name).  The API already scopes posts to the ticker's stream, but
    many posts are off-topic chatter mentioning other stocks.

    Returns (filtered_posts, FilterStats).
    """
    tp = _build_patterns(ticker, company)
    kept: list[dict] = []
    for post in posts:
        haystack = post.get("text", "") or post.get("text_clean", "")
        if _text_matches(haystack, tp):
            kept.append(post)

    label = f"{ticker} Stocktwits"
    return kept, FilterStats(label, len(posts), len(kept))


def log_filter_stats(stats_list: list[FilterStats]) -> None:
    """Print a compact noise-reduction summary block."""
    print("\n  ── Keyword Filter Results ──────────────────────────")
    total_before = sum(s.before for s in stats_list)
    total_after  = sum(s.after  for s in stats_list)
    for s in stats_list:
        marker = "✓" if s.dropped > 0 else "·"
        print(f"  {marker} {s}")
    overall_pct = ((total_before - total_after) / total_before * 100) if total_before else 0
    print(f"  ── Total: {total_before} → {total_after}  "
          f"({total_before - total_after} items removed, {overall_pct:.0f}% noise)")
    print()
