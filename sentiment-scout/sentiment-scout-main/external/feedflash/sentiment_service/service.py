"""
FeedFlash Sentiment Microservice
Integrates two sentiment engines:
  1. NLP ensemble (FinBERT + VADER + Dictionary) from:
       ../sentiment_analyzer
  2. Rule-based lexicon + ticker extraction from:
       ../social_pipeline  (DS440 social sentiment pipeline)

No API key required — all models run locally.

Start:
  python3 service.py

Endpoints:
  GET  /health              — liveness + model status (includes ds440 flag)
  POST /analyze-articles    — full NLP ensemble (FinBERT + VADER + Dictionary + DS440 rule score)
  POST /quick-sentiment     — DS440 rule-based only (instant, no model load required)
  POST /extract-tickers     — DS440 ticker extraction (~10k NYSE/NASDAQ symbols)
"""

import os
import sys
import re
import csv
import logging
from flask import Flask, request, jsonify
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# ── Ticker → Company map (from finviz.csv) ────────────────────────────────────
TICKER_COMPANY: dict[str, str] = {}
COMPANY_TO_TICKER: dict[str, str] = {}
SHORT_NAME_TO_TICKER: dict[str, str] = {}
SHORT_NAME_MCAP: dict[str, float] = {}

BLACKLIST_SHORT_NAMES = {'target', 'block', 'square', 'visa', 'best', 'alliance', 'resources', 'energy', 'partners', 'capital', 'financial', 'first', 'national', 'american', 'united', 'southwest', 'southern', 'northern', 'eastern', 'western', 'central', 'group', 'holdings', 'technologies', 'solutions', 'systems', 'enterprises', 'industries', 'sciences', 'biosciences', 'brands'}

def _load_ticker_company():
    global TICKER_COMPANY, COMPANY_TO_TICKER, SHORT_NAME_TO_TICKER, SHORT_NAME_MCAP
    csv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'social_pipeline', 'finviz.csv'))
    if not os.path.exists(csv_path):
        app.logger.warning(f'finviz.csv not found at {csv_path}')
        return
    try:
        with open(csv_path, newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                ticker  = (row.get('Ticker') or row.get('ticker') or '').strip().upper()
                company = (row.get('Company') or row.get('company') or '').strip()
                mcap_str = row.get('Market Cap') or '0'
                try:
                    mcap = float(mcap_str)
                except ValueError:
                    mcap = 0.0

                if ticker and company:
                    TICKER_COMPANY[ticker] = company
                    norm_c = company.lower().strip().rstrip('.')
                    COMPANY_TO_TICKER[norm_c] = ticker
                    
                    words = company.split()
                    suffixes = {'inc', 'inc.', 'corp', 'corp.', 'ltd', 'ltd.', 'plc', 'holdings', 'company', 'co', 'co.', 'group', 'sa', 's.a.', 'n.v.', 'lp', 'l.p.', 'bancorp'}
                    while words and words[-1].lower() in suffixes:
                        words.pop()
                    
                    if words:
                        short_name = " ".join(words).lower()
                        if len(short_name) > 3 and short_name not in BLACKLIST_SHORT_NAMES:
                            if short_name not in SHORT_NAME_TO_TICKER or mcap > SHORT_NAME_MCAP.get(short_name, -1):
                                SHORT_NAME_TO_TICKER[short_name] = ticker
                                SHORT_NAME_MCAP[short_name] = mcap
        app.logger.info(f'Loaded {len(TICKER_COMPANY)} ticker mappings, {len(SHORT_NAME_TO_TICKER)} short names')
    except Exception as e:
        app.logger.warning(f'Failed to load finviz.csv: {e}')

_load_ticker_company()

# ── Regex-based company name extractor ───────────────────────────────────────
# Catches "Exxon Mobil Corp", "Apple Inc.", "Wheaton Precious Metals Co." etc.
_COMPANY_SUFFIX_RE = re.compile(
    r'\b([A-Z][A-Za-z0-9&\'\-]+'          # first word, capitalised
    r'(?:\s+[A-Z][A-Za-z0-9&\'\-]+){0,4}' # up to 4 more capitalised words
    r'\s+(?:Inc\.?|Corp\.?|Ltd\.?|LLC\.?|L\.P\.?|Co\.?|PLC|plc'
    r'|Holdings?|Bancorp|Bancshares?|Pharmaceuticals?|Therapeutics?'
    r'|Technologies?|Solutions?|Systems?|Enterprises?|Industries?'
    r'|Sciences?|Biosciences?|Partners?|Capital|Financial|Brands?'
    r'|Energy|Resources?|Properties|Metals?|Mining|Group)\.?)\b'
)

def _extract_company_from_text(title: str, content: str = '') -> str | None:
    """Return first company name found in title (then content), or None."""
    for text in (title, content[:400]):
        m = _COMPANY_SUFFIX_RE.search(text)
        if m:
            return m.group(1).strip().rstrip('.')
    return None

# ── Load the NLP ensemble processor once at startup ──────────────────────────
processor = None
load_error = None

def load_processor():
    global processor, load_error
    try:
        from sentiment_analyzer.integrated_processor import FinancialSentimentProcessor
        processor = FinancialSentimentProcessor()
        app.logger.info('FinancialSentimentProcessor loaded successfully')
    except Exception as e:
        load_error = str(e)
        app.logger.error(f'Failed to load processor: {e}')


# ── Load DS440 rule-based ticker/sentiment modules ────────────────────────────
_ds440_ok = False
_extract_tickers_fn = None
_score_sentiment_fn = None

def _load_ds440():
    global _ds440_ok, _extract_tickers_fn, _score_sentiment_fn
    try:
        from social_pipeline.processing.ticker_extraction import extract_tickers
        from social_pipeline.processing.sentiment_engine import score_sentiment
        _extract_tickers_fn = extract_tickers
        _score_sentiment_fn = score_sentiment
        _ds440_ok = True
        app.logger.info('DS440 modules loaded (ticker extraction + rule-based sentiment)')
    except Exception as e:
        app.logger.warning(f'DS440 modules unavailable: {e}')


def _get_tickers_for_article(title: str, content_clean: str) -> list:
    """Helper to extract tickers using ML, explicit regex, and reliable short-name matches."""
    tickers = []
    if _ds440_ok:
        try:
            tickers = _extract_tickers_fn(title, content_clean)
        except Exception:
            pass

    if not tickers:
        company_match = _extract_company_from_text(title, content_clean)
        if company_match:
            norm_v = company_match.lower().strip().rstrip('.')
            if norm_v in COMPANY_TO_TICKER:
                tickers = [COMPANY_TO_TICKER[norm_v]]
            else:
                short = norm_v
                for suff in [' inc', ' corp', ' ltd', ' plc', ' holdings', ' company']:
                    short = short.replace(suff, '')
                short = short.strip()
                if short in SHORT_NAME_TO_TICKER:
                    tickers = [SHORT_NAME_TO_TICKER[short]]

    if not tickers:
        cap_words = re.findall(r'[A-Z][a-zA-Z0-9&\-]+', title)
        found_ticker = None
        for n in [4, 3, 2, 1]:
            if found_ticker: break
            for i in range(len(cap_words) - n + 1):
                ngram = " ".join(cap_words[i:i+n]).lower()
                if ngram in SHORT_NAME_TO_TICKER:
                    found_ticker = SHORT_NAME_TO_TICKER[ngram]
                    break
        if found_ticker:
            tickers = [found_ticker]
            
    return list(dict.fromkeys(tickers)) # deduplicate just in case


def _strip_html(text: str) -> str:
    return re.sub(r'<[^>]+>', '', text or '').strip()


def _score_to_label(combined: float) -> str:
    """Map [-1, 1] combined score to bullish/bearish/neutral."""
    if combined > 0.05:
        return 'bullish'
    elif combined < -0.05:
        return 'bearish'
    return 'neutral'


def _score_to_confidence(scores: dict) -> float:
    """
    Derive a [0, 1] confidence from model agreement + magnitude.
    Higher when models agree and the signal is strong.
    """
    combined   = abs(scores.get('combined', 0.0))
    finbert    = scores.get('ml_prediction', 0.0)
    vader      = scores.get('sentiment_vader', 0.0)
    keyword    = scores.get('keyword_based', 0.0)

    # Agreement: how many models point the same direction as combined
    direction  = 1 if scores.get('combined', 0) >= 0 else -1
    agreement  = sum(1 for s in [finbert, vader, keyword] if s * direction > 0) / 3.0

    confidence = (combined * 0.5) + (agreement * 0.5)
    return round(min(1.0, max(0.0, confidence)), 4)


# ─── Health ───────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok':    processor is not None,
        'model': 'FinBERT + VADER + Dictionary ensemble',
        'error': load_error,
        'service': 'feedflash-sentiment',
        'ds440': _ds440_ok,
    })


# ─── Analyze Articles ─────────────────────────────────────────────────────────

@app.route('/analyze-articles', methods=['POST'])
def analyze_articles():
    """
    Score a batch of articles through the full ensemble.

    Body:
      articles  — list of {id, title, content}

    Returns:
      { results: [{id, sentiment, confidence, scores}] }
        sentiment  — 'bullish' | 'bearish' | 'neutral'
        confidence — float [0, 1]
        scores     — raw component scores from the ensemble
    """
    if processor is None:
        return jsonify({'error': f'Processor not loaded: {load_error}'}), 503

    body     = request.json or {}
    articles = body.get('articles', [])

    if not articles:
        return jsonify({'results': []}), 200

    results = []
    for article in articles:
        article_id    = article.get('id', '')
        title         = (article.get('title') or '').strip()
        content_clean = _strip_html(article.get('content') or '')[:800]

        # Combine title + excerpt for scoring (title gets more weight by repetition)
        text = f"{title}. {title}. {content_clean}".strip()

        try:
            scores    = processor.calculate_enhanced_sentiment(text)
            sentiment = _score_to_label(scores.get('combined', 0.0))
            confidence = _score_to_confidence(scores)
        except Exception as e:
            app.logger.error(f'Scoring error for {article_id}: {e}')
            scores, sentiment, confidence = {}, None, None

        # DS440 rule-based score (fast, no model — included as extra signal)
        rule_score = None
        if _ds440_ok:
            try:
                rb = _score_sentiment_fn(title, content_clean)
                rule_score = rb
                if scores is not None:
                    scores['rule_based'] = rb['sentiment_score']
            except Exception:
                pass

        # Extract tickers utilizing both DS440 and finviz company mappings
        tickers = _get_tickers_for_article(title, content_clean)

        # Company name: ticker map first, then regex extraction from text
        company: str | None = None
        if tickers:
            company = TICKER_COMPANY.get(tickers[0].upper())
        if not company:
            company = _extract_company_from_text(title, content_clean)

        results.append({
            'id':         article_id,
            'sentiment':  sentiment,
            'confidence': confidence,
            'scores':     {k: round(v, 4) if isinstance(v, float) else v for k, v in scores.items()} if scores else {},
            'rule_based': rule_score,
            'tickers':    tickers,
            'company':    company,
        })

    return jsonify({'results': results})


# ─── Quick Sentiment (DS440 rule-based only) ──────────────────────────────────

@app.route('/quick-sentiment', methods=['POST'])
def quick_sentiment():
    """
    Score articles using DS440's rule-based lexicon engine only.
    Instant — no model loading required. Works even if FinBERT fails to load.

    Body:
      articles  — list of {id, title, content}

    Returns:
      { results: [{id, sentiment, confidence, score, method, signals}] }
    """
    if not _ds440_ok:
        return jsonify({'error': 'DS440 sentiment engine not available. Check vaderSentiment is installed.'}), 503

    body     = request.json or {}
    articles = body.get('articles', [])
    if not articles:
        return jsonify({'results': []}), 200

    results = []
    for article in articles:
        article_id    = article.get('id', '')
        title         = (article.get('title') or '').strip()
        content_clean = _strip_html(article.get('content') or '')[:800]

        try:
            rb         = _score_sentiment_fn(title, content_clean)
            score      = rb['sentiment_score']
            method     = rb['sentiment_method']
            signals    = rb['sentiment_signals']
            sentiment  = _score_to_label(score)
            confidence = round(min(1.0, abs(score)), 4)
        except Exception as e:
            app.logger.error(f'Quick sentiment error for {article_id}: {e}')
            score, method, signals, sentiment, confidence = 0.0, 'error', 0, None, None

        results.append({
            'id':         article_id,
            'sentiment':  sentiment,
            'confidence': confidence,
            'score':      score,
            'method':     method,
            'signals':    signals,
        })

    return jsonify({'results': results})


# ─── Ticker Extraction (DS440) ────────────────────────────────────────────────

@app.route('/extract-tickers', methods=['POST'])
def extract_tickers_endpoint():
    """
    Extract stock ticker symbols from article titles and content using
    DS440's three-tier regex engine (cashtags → parenthesized → bare uppercase),
    validated against ~10k NYSE/NASDAQ symbols.

    Body:
      articles  — list of {id, title, content}

    Returns:
      { results: [{id, tickers}] }
    """
    if not _ds440_ok:
        return jsonify({'error': 'DS440 ticker extraction not available.'}), 503

    body     = request.json or {}
    articles = body.get('articles', [])
    if not articles:
        return jsonify({'results': []}), 200

    results = []
    for article in articles:
        article_id    = article.get('id', '')
        title         = (article.get('title') or '').strip()
        content_clean = _strip_html(article.get('content') or '')

        try:
            tickers = _get_tickers_for_article(title, content_clean)
        except Exception as e:
            app.logger.error(f'Ticker extraction error for {article_id}: {e}')
            tickers = []

        results.append({'id': article_id, 'tickers': tickers})

    return jsonify({'results': results})


# ── DS440 modules are lightweight — load at import time for gunicorn/Railway ──
_load_ds440()

# ─── Start ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    load_processor()   # heavy FinBERT model — only on direct run
    port = int(os.getenv('PORT', '5001'))
    ds440_status = 'DS440 rule-based engine ready' if _ds440_ok else 'DS440 modules unavailable'
    print(f'\n  FeedFlash Sentiment Service  ->  http://localhost:{port}')
    print(f'  Model: FinBERT + VADER + Dictionary (no API key required)')
    print(f'  {ds440_status}\n')
    app.run(host='0.0.0.0', port=port, debug=False)
