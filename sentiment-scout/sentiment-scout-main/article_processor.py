"""
Article Pre-Processor
─────────────────────
Fetches and cleans full article text from a URL, then chunks it to
≤512 tokens so it is ready for FinBERT ingestion in Phase 4.

Public API
──────────
  process_article(url, fallback="") -> ArticleResult
      Fetches the URL, extracts clean body text, chunks to 512 tokens,
      and returns an ArticleResult.  On any failure the fallback string
      (typically the RSS description) is returned instead.

Token budget
────────────
FinBERT uses WordPiece tokenisation; empirically 1 token ≈ 4–5 chars.
We conservatively treat 1 token ≈ 4 chars, so 512 tokens ≈ 2048 chars.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import NamedTuple

from bs4 import BeautifulSoup
from curl_cffi import requests

# ─── CONFIG ───────────────────────────────────────────────────────────────────

FETCH_TIMEOUT     = 12      # seconds — fast fail to keep the pipeline moving
MAX_CHARS         = 2048    # ≈ 512 FinBERT tokens (4 chars/token conservative)
MAX_ARTICLE_BYTES = 500_000 # skip very large pages (PDF dumps, etc.)

_FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.google.com/",
}

# Tags whose entire subtree is boilerplate — strip before text extraction
_STRIP_TAGS = {
    "script", "style", "noscript", "nav", "header", "footer",
    "aside", "form", "iframe", "figure", "figcaption",
    "button", "input", "select", "textarea", "label",
    "advertisement", "ad", "banner",
}

# CSS class/id substrings that flag boilerplate containers
_NOISE_PATTERNS = re.compile(
    r"(nav|navbar|sidebar|footer|header|cookie|banner|ad[-_]|"
    r"advertisement|subscribe|newsletter|promo|popup|modal|"
    r"related|recommend|comment|social|share|widget|menu|"
    r"breadcrumb|pagination|tag-cloud|trending)",
    re.IGNORECASE,
)

# Preferred article containers (tried in order, first match wins)
_ARTICLE_SELECTORS = [
    "article",
    '[itemprop="articleBody"]',
    '[class*="article-body"]',
    '[class*="article__body"]',
    '[class*="story-body"]',
    '[class*="post-body"]',
    '[class*="entry-content"]',
    '[class*="article-content"]',
    '[class*="content-body"]',
    "main",
    '[role="main"]',
]


# ─── RESULT TYPE ──────────────────────────────────────────────────────────────

@dataclass
class ArticleResult:
    url:        str
    text:       str           # clean body text, ≤ MAX_CHARS
    source:     str           # "full" | "fallback"
    char_count: int = field(init=False)

    def __post_init__(self):
        self.char_count = len(self.text)

    @property
    def is_full(self) -> bool:
        return self.source == "full"


# ─── FETCH ────────────────────────────────────────────────────────────────────

def _fetch_html(url: str) -> str | None:
    """Return raw HTML string or None on failure."""
    if not url or not url.startswith("http"):
        return None
    try:
        resp = requests.get(
            url,
            headers=_FETCH_HEADERS,
            impersonate="chrome124",
            timeout=FETCH_TIMEOUT,
        )
        resp.raise_for_status()
        # Skip very large documents
        if len(resp.content) > MAX_ARTICLE_BYTES:
            return None
        return resp.text
    except Exception:
        return None


# ─── EXTRACTION ───────────────────────────────────────────────────────────────

def _is_noisy_element(tag) -> bool:
    """Return True if the element looks like boilerplate."""
    attrs = getattr(tag, "attrs", None)
    if not attrs:
        return False
    cls = " ".join(attrs.get("class") or [])
    if _NOISE_PATTERNS.search(cls):
        return True
    eid = attrs.get("id") or ""
    if _NOISE_PATTERNS.search(eid):
        return True
    return False


def _extract_text_bs4(html: str) -> str:
    """
    BeautifulSoup extraction pipeline:
      1. Strip boilerplate tags entirely.
      2. Find the best article container.
      3. Remove noisy child elements.
      4. Collect paragraph text.
    """
    soup = BeautifulSoup(html, "lxml")

    # 1. Nuke boilerplate tags
    for tag in soup.find_all(_STRIP_TAGS):
        tag.decompose()

    # 2. Find best container
    container = None
    for selector in _ARTICLE_SELECTORS:
        container = soup.select_one(selector)
        if container:
            break
    if not container:
        container = soup.find("body") or soup

    # 3. Remove noisy children in-place
    for el in container.find_all(True):
        if _is_noisy_element(el):
            el.decompose()

    # 4. Collect paragraph text
    paragraphs = []
    for p in container.find_all(["p", "li", "h2", "h3"]):
        txt = p.get_text(separator=" ", strip=True)
        if len(txt) > 40:  # skip stub fragments
            paragraphs.append(txt)

    if paragraphs:
        return " ".join(paragraphs)

    # Fallback: all text in container
    return re.sub(r"\s+", " ", container.get_text(separator=" ", strip=True))


def _extract_text_newspaper(html: str, url: str) -> str | None:
    """Try newspaper3k for extraction; return None on failure."""
    try:
        import newspaper
        art = newspaper.Article(url)
        art.set_html(html)
        art.parse()
        text = (art.text or "").strip()
        return text if len(text) > 100 else None
    except Exception:
        return None


# ─── CHUNKING ─────────────────────────────────────────────────────────────────

def _chunk(text: str, max_chars: int = MAX_CHARS) -> str:
    """
    Return the first `max_chars` characters of clean text, cutting on a
    sentence boundary where possible so FinBERT doesn't receive a half-sentence.
    """
    if len(text) <= max_chars:
        return text
    # Try to cut at last sentence boundary within budget
    chunk = text[:max_chars]
    last_period = max(chunk.rfind(". "), chunk.rfind("! "), chunk.rfind("? "))
    if last_period > max_chars // 2:
        return chunk[: last_period + 1].strip()
    return chunk.strip()


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

def process_article(url: str, fallback: str = "") -> ArticleResult:
    """
    Fetch `url`, extract and clean body text, chunk to ≤512 FinBERT tokens.

    Falls back to `fallback` (typically the RSS description) on any error.
    The returned ArticleResult.source is "full" on success or "fallback" on error.
    """
    html = _fetch_html(url)
    if not html:
        return ArticleResult(url=url, text=_chunk(fallback), source="fallback")

    # Try newspaper3k first (better boilerplate removal for news sites)
    text = _extract_text_newspaper(html, url)

    # Fall through to BS4 if newspaper got nothing useful
    if not text:
        text = _extract_text_bs4(html)

    # Normalise whitespace
    text = re.sub(r"\s+", " ", text).strip()

    if len(text) < 80:
        # Extraction yielded almost nothing — use fallback
        return ArticleResult(url=url, text=_chunk(fallback), source="fallback")

    return ArticleResult(url=url, text=_chunk(text), source="full")


# ─── BATCH STATS ──────────────────────────────────────────────────────────────

class ProcessingStats(NamedTuple):
    total:    int
    full:     int
    fallback: int

    def __str__(self) -> str:
        pct = (self.full / self.total * 100) if self.total else 0
        return (
            f"Article fetch: {self.full}/{self.total} full "
            f"({pct:.0f}% success, {self.fallback} used RSS description)"
        )
