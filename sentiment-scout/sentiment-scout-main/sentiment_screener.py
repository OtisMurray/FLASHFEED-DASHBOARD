"""
Real-Time Financial Sentiment Analysis Tool
Uses Finviz Elite for stock screening, scrapes news articles, and gets AI insights via OpenRouter.
Results are persisted to SQLite via database.py.
"""

import csv
import json
import time
import io
import re
from curl_cffi import requests
from bs4 import BeautifulSoup
import database
import rss_poller
import stocktwits_scraper
import keyword_filter
import article_processor
import multicap_screener   # capture_session() — shared session tagging
import config

# ─── CONFIG ────────────────────────────────────────────────────────────────────
OPENROUTER_API_KEY = config.require_env("OPENROUTER_API_KEY")  # .env OPENROUTER_API_KEY
OPENROUTER_MODEL = "anthropic/claude-sonnet-4-5"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DELAY_BETWEEN_CALLS = 1.5   # seconds between OpenRouter requests
ARTICLE_WORD_LIMIT = 500    # max words pulled from each article
NEWS_HEADLINES_LIMIT = 3    # top N headlines per ticker
OUTPUT_FILE = "insights_output.json"
# ───────────────────────────────────────────────────────────────────────────────

# v=152 = custom view; c= selects columns explicitly:
# 0 No. | 1 Ticker | 2 Company | 3 Sector | 4 Industry | 5 Country | 6 Market Cap
# 59 RSI (14) | 63 Average Volume | 64 Relative Volume | 65 Price | 66 Change | 67 Volume
# Query without the auth token; the token is appended at call time (finviz_url)
# from config.get_finviz_token() so a Settings-saved token applies with no restart.
_FINVIZ_QUERY = (
    "https://elite.finviz.com/export"
    "?v=152"
    "&f=news_date_prevminutes15|prevhours1,sh_avgvol_o100,sh_relvol_o1"
    "&o=-relativevolume"
    "&c=0,1,2,3,4,5,6,59,63,64,65,66,67,71,72,81,86"
)


def finviz_url() -> str:
    """Screener export URL with the live Finviz token (Settings store or .env),
    resolved at call time."""
    return f"{_FINVIZ_QUERY}&auth={config.get_finviz_token()}"

CURL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finviz.com/",
}


# ─── STEP 1: FINVIZ SCREENER ───────────────────────────────────────────────────

def fetch_finviz_tickers() -> list[dict]:
    """Fetch screener results from Finviz Elite and return as list of dicts."""
    print("Fetching tickers from Finviz Elite...")
    url = finviz_url()
    print(f"  URL: {_FINVIZ_QUERY}&auth=***")   # never log the token
    # Finviz rate-limits when the multicap screener polls concurrently — retry 429s
    for attempt in range(4):
        resp = requests.get(
            url,
            headers=CURL_HEADERS,
            impersonate="chrome124",
            timeout=30,
        )
        if resp.status_code == 429 and attempt < 3:
            wait = 5 * (attempt + 1)
            print(f"  [WARN] HTTP 429 rate-limited, retrying in {wait}s...")
            time.sleep(wait)
            continue
        break
    resp.raise_for_status()

    content = resp.text.strip()
    if not content:
        raise ValueError("Finviz returned an empty response.")

    reader = csv.DictReader(io.StringIO(content))
    print(f"  CSV columns: {reader.fieldnames}")
    rows = list(reader)
    if not rows:
        raise ValueError("No tickers matched the Finviz screener filters.")

    def _col(row: dict, *names: str) -> str:
        """Return the first non-empty value among possible CSV header names."""
        for name in names:
            val = row.get(name)
            if val is not None and str(val).strip():
                return str(val).strip()
        return ""

    tickers = []
    for row in rows:
        tickers.append({
            "ticker": _col(row, "Ticker"),
            "company": _col(row, "Company"),
            "sector": _col(row, "Sector"),
            "market_cap": _col(row, "Market Cap"),
            "price": _col(row, "Price"),
            "change_pct": _col(row, "Change"),
            "volume": _col(row, "Volume"),
            "relative_volume": _col(row, "Relative Volume", "Rel Volume"),
            "rsi": _col(row, "Relative Strength Index (14)", "RSI (14)", "RSI"),
            "avg_volume": _col(row, "Average Volume", "Avg Volume"),
            "ah_close": _col(row, "After-Hours Close"),
            "ah_change": _col(row, "After-Hours Change"),
            "prev_close": _col(row, "Prev Close"),
            "open_price": _col(row, "Open"),
            "capture_session": multicap_screener.capture_session(),
        })

    print(f"  Found {len(tickers)} ticker(s): {[t['ticker'] for t in tickers]}")
    return tickers


# ─── STEP 2: NEWS SCRAPING ─────────────────────────────────────────────────────

def fetch_finviz_news(ticker: str) -> list[dict]:
    """
    Scrape the Finviz quote page for a ticker and return the top N recent headlines.
    Each item: {"timestamp": str, "headline": str, "url": str}
    """
    url = f"https://finviz.com/quote.ashx?t={ticker}&ty=c&ta=1&p=d"
    try:
        resp = requests.get(
            url,
            headers=CURL_HEADERS,
            impersonate="chrome124",
            timeout=20,
        )
        resp.raise_for_status()
    except Exception as e:
        print(f"    [WARN] Could not fetch Finviz page for {ticker}: {e}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")

    # Finviz news table rows have class "cursor-pointer" or sit inside id="news-table"
    news_table = soup.find("table", id="news-table")
    if not news_table:
        # Fallback: look for the news section by heading
        print(f"    [WARN] No news table found for {ticker}")
        return []

    headlines = []
    current_date = ""
    for row in news_table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue

        timestamp_raw = cells[0].get_text(strip=True)
        # Rows show full date only on first entry of that day; subsequent show time only
        if re.match(r"\w{3}-\d{2}-\d{2}", timestamp_raw):
            # e.g. "May-15-24  08:30AM"
            parts = timestamp_raw.split()
            current_date = parts[0] if parts else timestamp_raw
            timestamp = timestamp_raw
        else:
            timestamp = f"{current_date} {timestamp_raw}" if current_date else timestamp_raw

        link_tag = cells[1].find("a")
        if not link_tag:
            continue

        headline = link_tag.get_text(strip=True)
        article_url = link_tag.get("href", "")

        if headline and article_url:
            headlines.append({
                "timestamp": timestamp,
                "headline": headline,
                "url": article_url,
            })

        if len(headlines) >= NEWS_HEADLINES_LIMIT:
            break

    return headlines


def fetch_article_text(url: str) -> str:
    """
    Fetch and extract readable body text from a news article URL.
    Returns up to ARTICLE_WORD_LIMIT words, or empty string on failure.
    """
    if not url or not url.startswith("http"):
        return ""

    try:
        resp = requests.get(
            url,
            headers={
                **CURL_HEADERS,
                "Referer": "https://www.google.com/",
            },
            impersonate="chrome124",
            timeout=15,
        )
        resp.raise_for_status()
    except Exception:
        return ""

    try:
        soup = BeautifulSoup(resp.text, "lxml")

        # Remove boilerplate tags
        for tag in soup(["script", "style", "nav", "footer", "header",
                         "aside", "form", "noscript", "iframe"]):
            tag.decompose()

        # Try common article containers first
        body = None
        for selector in ["article", "main", '[class*="article"]',
                         '[class*="story"]', '[class*="content"]',
                         '[class*="body"]', "div.post", "div#content"]:
            body = soup.select_one(selector)
            if body:
                break

        text_source = body if body else soup.find("body")
        if not text_source:
            return ""

        raw_text = text_source.get_text(separator=" ", strip=True)
        # Collapse whitespace
        raw_text = re.sub(r"\s+", " ", raw_text).strip()

        words = raw_text.split()
        return " ".join(words[:ARTICLE_WORD_LIMIT])

    except Exception:
        return ""


def enrich_ticker_with_news(
    stock: dict,
    rss_index: dict | None = None,
    article_stats: list | None = None,
) -> dict:
    """
    Fetch news context for a ticker.

    Priority:
    1. RSS articles — full body fetched via article_processor; falls back to
       RSS description if the fetch fails or times out.
    2. Finviz news headlines + full article scrape (fills remaining slots).

    article_stats: mutable list[ArticleResult] — caller appends results here
    for the end-of-run summary.
    """
    ticker = stock["ticker"]
    print(f"  Scraping news for {ticker}...")

    enriched_news = []

    # ── RSS-sourced articles (full text via article_processor) ────────────────
    rss_articles = rss_poller.get_rss_context_for_ticker(ticker, rss_index or {})
    for article in rss_articles:
        headline    = article.get("title", "")
        description = article.get("description", "")
        url         = article.get("link", "")

        result = article_processor.process_article(url, fallback=description)
        if article_stats is not None:
            article_stats.append(result)

        tag = "FULL" if result.is_full else "DESC"
        print(f"    [RSS:{article['source']}|{tag}] {headline[:65]}...")

        enriched_news.append({
            "timestamp":    article.get("published_at", ""),
            "headline":     headline,
            "url":          url,
            "article_text": result.text,
            "source":       article.get("source", "RSS"),
        })

    # ── Finviz news headlines (fill any remaining slots) ──────────────────────
    remaining_slots = max(0, NEWS_HEADLINES_LIMIT - len(enriched_news))
    if remaining_slots > 0:
        headlines = fetch_finviz_news(ticker)
        if not headlines and not enriched_news:
            print(f"    No headlines found for {ticker}")
        for item in headlines[:remaining_slots]:
            print(f"    • {item['headline'][:70]}...")
            article_text = fetch_article_text(item["url"])
            enriched_news.append({
                "timestamp":    item["timestamp"],
                "headline":     item["headline"],
                "url":          item["url"],
                "article_text": article_text,
                "source":       "Finviz",
            })

    stock["news"] = enriched_news
    return stock


# ─── STEP 3: CLAUDE PROMPT ────────────────────────────────────────────────────

def build_news_section(news_items: list[dict]) -> str:
    if not news_items:
        return "No recent news found."

    parts = []
    for i, item in enumerate(news_items, 1):
        parts.append(f"[News {i}] {item['timestamp']} — {item['headline']}")
        if item.get("article_text"):
            parts.append(f"Article excerpt: {item['article_text'][:800]}")
        parts.append("")

    return "\n".join(parts).strip()


def build_analyst_prompt(stock: dict) -> str:
    news_section = build_news_section(stock.get("news", []))
    st_section   = stocktwits_scraper.build_stocktwits_prompt_section(
                       stock.get("stocktwits") or {})
    high_conv_flag = ""
    if stock.get("high_conviction"):
        high_conv_flag = (
            "\n⚡ HIGH CONVICTION SIGNAL: This ticker appeared in BOTH the Finviz volume "
            "screener AND real-time RSS news feeds within the last 30 minutes. "
            "News just dropped and volume is already responding — weight your conviction higher.\n"
        )

    return f"""You are a professional day trader and financial analyst. Evaluate this stock for an actionable intraday trading opportunity that must be acted on NOW — before the general public reacts.
{high_conv_flag}
Stock data:
- Ticker: {stock['ticker']} ({stock['company']})
- Sector: {stock['sector']}
- Market Cap: {stock['market_cap']}
- Price: {stock['price']}
- Change: {stock['change_pct']}
- Volume: {stock['volume']}
- Relative Volume: {stock['relative_volume']}x
- RSI (14): {stock['rsi']}
- Avg Volume: {stock['avg_volume']}

Recent News & Catalysts:
{news_section}

Social Sentiment (Stocktwits):
{st_section}

Instructions:
1. Identify whether the news is the ACTUAL catalyst driving the move, or just background noise.
2. Assess whether the market has already priced in the news (is this early, mid, or extended?).
3. Factor BOTH news content AND Stocktwits social sentiment into your direction and conviction.
   - A bullish price move with heavy Bearish Stocktwits posts is a divergence signal (late move).
   - A bullish price move with heavy Bullish posts suggests retail is piling in (confirm or fade?).
4. If HIGH CONVICTION SIGNAL is present, reflect this in a conviction score of at least 7.
5. Provide a one-sentence news_catalyst describing the real driver.
6. Provide a punchy one-line `reason` (≤14 words) stating the single biggest factor behind this direction and conviction score — this is shown as the ranking rationale.

Return ONLY a valid JSON object (no markdown, no explanation) with these exact fields:
{{
  "ticker": "<TICKER>",
  "direction": "<long|short|neutral>",
  "conviction": <integer 1-10>,
  "timing": "<early|mid|extended>",
  "reason": "<One line, max 14 words: the single biggest reason for this direction and conviction.>",
  "risk_factors": ["<factor1>", "<factor2>"],
  "summary": "<Two sentences max describing the trade thesis and key risk.>",
  "news_catalyst": "<One sentence: what is the actual news driver and is it priced in?>"
}}"""


# ─── STEP 4: OPENROUTER CALL ──────────────────────────────────────────────────

def get_ai_insight(stock: dict) -> dict | None:
    """Send stock + news data to Claude via OpenRouter and return parsed JSON insight."""
    ticker = stock["ticker"]
    print(f"  Analyzing {ticker} with Claude...")

    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {"role": "user", "content": build_analyst_prompt(stock)}
        ],
        "temperature": 0.3,
        "max_tokens": 600,
    }

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/sentiment-screener",
        "X-Title": "Sentiment Screener",
    }

    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers=headers,
            json=payload,
            impersonate="chrome124",
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        raw = data["choices"][0]["message"]["content"].strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        insight = json.loads(raw)
        return insight

    except json.JSONDecodeError as e:
        print(f"    [WARN] Could not parse JSON for {ticker}: {e}")
        return {"ticker": ticker, "error": "JSON parse failed", "raw": raw}
    except Exception as e:
        print(f"    [ERROR] OpenRouter call failed for {ticker}: {e}")
        return {"ticker": ticker, "error": str(e)}


# ─── OUTPUT ───────────────────────────────────────────────────────────────────

def print_insight(insight: dict):
    print("\n" + "=" * 60)
    ticker = insight.get("ticker", "?")
    if "error" in insight:
        print(f"  {ticker} — ERROR: {insight['error']}")
        return

    direction = insight.get("direction", "neutral").upper()
    conviction = insight.get("conviction", "?")
    timing = insight.get("timing", "?")
    risks = insight.get("risk_factors", [])
    summary = insight.get("summary", "")
    catalyst = insight.get("news_catalyst", "")

    hc = " ⚡ HIGH CONVICTION" if insight.get("high_conviction") else ""
    dir_symbol = {"LONG": "▲", "SHORT": "▼", "NEUTRAL": "●"}.get(direction, "●")
    print(f"  {dir_symbol} {ticker}  |  Direction: {direction}  |  Conviction: {conviction}/10  |  Timing: {timing}{hc}")
    print(f"  Catalyst: {catalyst}")
    print(f"  Summary:  {summary}")
    if risks:
        print(f"  Risks:    {' · '.join(risks)}")
    print("=" * 60)


# ─── PIPELINE (callable by scheduler) ────────────────────────────────────────

def run_pipeline() -> dict:
    """
    Execute one full screening cycle.

    Returns a result dict:
        success   bool   — True if pipeline completed without fatal error
        tickers   list   — ticker symbols processed
        count     int    — number of tickers
        run_id    int    — database run id (None on failure)
        error     str    — error message if failed, else None
    """
    result = {"success": False, "tickers": [], "count": 0, "run_id": None, "error": None}

    database.init_db()

    # Performance check on stale predictions
    database.check_performance()

    # ── RSS ───────────────────────────────────────────────────────────────────
    print("\nFetching RSS feeds...")
    try:
        rss_articles = rss_poller.fetch_all_feeds(max_age_minutes=120)
        rss_index    = rss_poller.build_rss_index(rss_articles)
        recent_arts  = rss_poller.fetch_all_feeds(max_age_minutes=30)
    except Exception as e:
        print(f"  [WARN] RSS fetch failed: {e}")
        rss_articles, rss_index, recent_arts = [], {}, []

    recent_rss_tickers: set[str] = set()
    for a in recent_arts:
        recent_rss_tickers.update(a.get("extracted_tickers", []))
    print(f"  {len(rss_articles)} RSS items | "
          f"{len(recent_rss_tickers)} tickers in last 30 min")

    # ── Finviz screener ───────────────────────────────────────────────────────
    try:
        tickers = fetch_finviz_tickers()
    except Exception as e:
        result["error"] = f"Finviz fetch failed: {e}"
        print(f"\n[FATAL] {result['error']}")
        return result

    if not tickers:
        result["error"] = "No tickers matched Finviz filters"
        print(f"[FATAL] {result['error']}")
        return result

    finviz_ticker_set = {s["ticker"] for s in tickers}

    # ── Keyword filter — compile patterns once for all tickers ───────────────
    ticker_patterns = keyword_filter.build_ticker_patterns(tickers)

    # High-conviction cross-reference
    high_conviction_tickers = finviz_ticker_set & recent_rss_tickers
    if high_conviction_tickers:
        print(f"  ⚡ High-conviction: {sorted(high_conviction_tickers)}")
    for stock in tickers:
        stock["high_conviction"] = stock["ticker"] in high_conviction_tickers

    # ── Keyword filter: RSS ───────────────────────────────────────────────────
    all_filter_stats: list[keyword_filter.FilterStats] = []
    if rss_articles and ticker_patterns:
        rss_articles, rss_stats = keyword_filter.filter_rss_articles(
            rss_articles, ticker_patterns,
            user_keywords=keyword_filter.load_user_keywords(),
        )
        all_filter_stats.append(rss_stats)
        # Rebuild index from filtered articles so only relevant news reaches Claude
        rss_index = rss_poller.build_rss_index(rss_articles)

    # Persist RSS items (after filtering so only relevant ones are stored)
    database.save_rss_items(rss_articles, finviz_ticker_set)

    # ── News enrichment + Stocktwits ─────────────────────────────────────────
    print(f"\nScraping news + Stocktwits for {len(tickers)} ticker(s)...")
    article_results: list[article_processor.ArticleResult] = []
    for stock in tickers:
        enrich_ticker_with_news(stock, rss_index, article_stats=article_results)

        ticker  = stock["ticker"]
        company = stock.get("company", "")
        print(f"  Fetching Stocktwits for {ticker}...")
        st_data = stocktwits_scraper.fetch_stocktwits(ticker)

        # ── Keyword filter: Stocktwits posts ──────────────────────────────────
        if st_data.get("posts"):
            filtered_posts, st_stats = keyword_filter.filter_stocktwits_posts(
                st_data["posts"], ticker, company
            )
            all_filter_stats.append(st_stats)
            # Update the data dict with filtered posts and recalculated counts
            st_data["posts"]         = filtered_posts
            st_data["message_count"] = len(filtered_posts)
            st_data["bullish_count"] = sum(
                1 for p in filtered_posts if p.get("sentiment") == "Bullish"
            )
            st_data["bearish_count"] = sum(
                1 for p in filtered_posts if p.get("sentiment") == "Bearish"
            )

        stock["stocktwits"] = st_data
        if st_data.get("error"):
            print(f"    [WARN] Stocktwits: {st_data['error']}")
        else:
            bulls = st_data["bullish_count"]
            bears = st_data["bearish_count"]
            total = st_data["message_count"]
            print(f"    {total} posts — 🟢 {bulls} bullish / 🔴 {bears} bearish")

        time.sleep(0.3)

    # ── Log article fetch summary ─────────────────────────────────────────────
    if article_results:
        stats = article_processor.ProcessingStats(
            total    = len(article_results),
            full     = sum(1 for r in article_results if r.is_full),
            fallback = sum(1 for r in article_results if not r.is_full),
        )
        print(f"\n  ── Article Pre-Processing ──────────────────────────")
        print(f"  ✓ {stats}")
        print()

    # ── Log noise-reduction summary ───────────────────────────────────────────
    if all_filter_stats:
        keyword_filter.log_filter_stats(all_filter_stats)

    # ── AI insights ───────────────────────────────────────────────────────────
    print(f"\nRunning AI analysis on {len(tickers)} ticker(s)...")
    all_insights = []
    run_id = database.save_run(len(tickers))

    for i, stock in enumerate(tickers):
        insight = get_ai_insight(stock)
        if insight:
            insight["high_conviction"] = stock.get("high_conviction", False)
            all_insights.append(insight)
            print_insight(insight)
            if "error" not in insight:
                database.save_insight(run_id, stock, insight)
        if i < len(tickers) - 1:
            time.sleep(DELAY_BETWEEN_CALLS)

    # Save JSON snapshot
    with open(OUTPUT_FILE, "w") as f:
        json.dump(all_insights, f, indent=2)

    ticker_syms = [s["ticker"] for s in tickers]
    print(f"\n✓ {len(all_insights)} insights saved (run_id={run_id})\n")

    result.update({
        "success": True,
        "tickers": ticker_syms,
        "count": len(ticker_syms),
        "run_id": run_id,
    })
    return result


# ─── MAIN (CLI entry point) ───────────────────────────────────────────────────

def main():
    print("\n━━━  SENTIMENT SCREENER  ━━━\n")
    run_pipeline()


if __name__ == "__main__":
    main()
