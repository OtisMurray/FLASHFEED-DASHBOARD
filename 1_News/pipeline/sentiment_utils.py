"""Shared lightweight financial sentiment scoring.

This is intentionally deterministic and fast for ingestion. It catches common
market-moving phrases before any slower LLM/FinBERT batch scorer is added.
"""

from __future__ import annotations

import math
import re


Pattern = tuple[re.Pattern[str], float]
EventPattern = tuple[str, re.Pattern[str], float, str]


def _compile(weighted_patterns: list[tuple[str, float]]) -> list[Pattern]:
    return [(re.compile(pattern, re.IGNORECASE), weight) for pattern, weight in weighted_patterns]


BULLISH_PATTERNS = _compile([
    (r"\b(?:beat|beats|beating|tops|exceeds?)\b.{0,28}\b(?:estimate|estimates|expectations|consensus|forecast)\b", 2.4),
    (r"\b(?:better[-\s]?than[-\s]?expected|above[-\s]?consensus|ahead of expectations)\b", 2.1),
    (r"\b(?:raises?|raised|boosts?|boosted|lifts?|lifted|increases?)\b.{0,28}\b(?:guidance|outlook|forecast|target|dividend|buyback)\b", 2.2),
    (r"\b(?:raises?|raised|secures?|secured)\b.{0,24}\$?\d+(?:\.\d+)?\s?(?:m|mn|million|b|bn|billion)\b", 1.8),
    (r"\b(?:announces?|reported|reports|posts?|delivers?)\b.{0,32}\b(?:record|strong|robust|solid|profitable|accelerating)\b.{0,32}\b(?:revenue|sales|earnings|profit|ebitda|margin|growth|quarter|results)\b", 1.9),
    (r"\b(?:worth|valuation|valued at)\b.{0,24}\$?\d+(?:\.\d+)?\s?(?:m|mn|million|b|bn|billion|t|tn|trillion)\b", 1.2),
    (r"\b(?:largest|historic|massive|successful)\b.{0,24}\b(?:ipo|debut|launch|stock market debut|trading debut)\b", 1.4),
    (r"\b(?:upgrade|upgraded|outperform|overweight|buy rating|initiates? at buy|initiates? coverage with buy|price target raised|raises? price target)\b", 1.8),
    (r"\b(?:fda|regulator|regulatory)\b.{0,32}\b(?:approval|approves?|clearance|clears?|authorized|accepted)\b", 2.3),
    (r"\b(?:clearance|approval|authorization|accepted|acceptance)\b.{0,32}\b(?:510\(k\)|ind|nda|bla|pma|fda|ema)\b", 2.2),
    (r"\b(?:fast track|breakthrough therapy|orphan drug|priority review|rare pediatric disease)\b.{0,24}\b(?:designation|granted|status|voucher)\b", 2.0),
    (r"\b(?:positive|successful|promising|met|meets?|achieved|achieves)\b.{0,28}\b(?:primary endpoint|secondary endpoint|trial|study|phase|endpoint|data|results|topline|top-line)\b", 2.0),
    (r"\b(?:primary endpoint|secondary endpoint)\b.{0,28}\b(?:met|achieved|statistically significant)\b", 2.2),
    (r"\b(?:proof-of-concept|proof of concept|first-in-class|best-in-class)\b", 1.2),
    (r"\b(?:sustained|durable|significant|rapid|long-term)\b.{0,32}\b(?:improvement|efficacy|benefit|response|results)\b", 1.5),
    (r"\b(?:encouraging|promising|favorable)\b.{0,32}\b(?:safety|activity|profile|clinical activity|data)\b", 1.6),
    (r"\b(?:blowout|stellar|blockbuster)\b.{0,18}\b(?:data|results|earnings|quarter|report)\b", 1.5),
    (r"\b(?:record|strong|robust|solid)\b.{0,24}\b(?:revenue|sales|earnings|profit|margin|demand|orders)\b", 1.6),
    (r"\b(?:revenue|sales|earnings|profit|eps|margin|ebit|ebitda|operating income|net income)\b.{0,28}\b(?:rise|rises|rose|grow|grows|grew|jump|jumps|surge|surges|increase|increases|double|doubles|doubled|triple|triples|tripled)\b", 1.7),
    (r"\b(?:double|doubles|doubled|triple|triples|tripled|significantly above|well above)\b.{0,28}\b(?:previous year|prior year|year[-\s]?ago|revenue|sales|earnings|profit|eps|margin|ebit|ebitda|operating income|net income|level)\b", 1.7),
    (r"\b(?:growth catalyst|growth catalysts|major catalyst|major catalysts|transformational catalyst|strategic catalyst)\b", 1.2),
    (r"\b(?:stock|shares?)\b.{0,24}\b(?:rockets?|soars?|surges?|jumps?|rall(?:y|ies)|gains?|pops?|climbs?)\b", 1.4),
    (r"\b(?:rockets?|soars?|surges?|jumps?|rall(?:y|ies)|gains?|pops?|climbs?)\b.{0,18}\b\d+(?:\.\d+)?%", 1.4),
    (r"\b(?:room to run|ready for liftoff|liftoff|buyers are back|upside remains?)\b", 1.1),
    (r"\b(?:contract|award|purchase order|order|partnership|collaboration|supply agreement|strategic agreement|distribution agreement|license agreement|commercial agreement)\b", 1.1),
    (r"\b(?:wins?|won|awarded|selected|chosen|receives?|received|secures?|secured)\b.{0,28}\b(?:contract|award|order|purchase order|customer|program|tender|agreement)\b", 1.8),
    (r"\b(?:launches?|launched|commercializes?|commercialized|rolls out|expands?|expanded)\b.{0,32}\b(?:product|platform|service|market|program|operations|coverage|facility)\b", 1.2),
    (r"\b(?:patent|intellectual property)\b.{0,24}\b(?:granted|issued|allowed|allowance)\b", 1.3),
    (r"\b(?:insider buying|insiders? buy|director buys|ceo buys|open market purchase)\b", 1.5),
    (r"\b(?:buyback|repurchase|dividend increase|special dividend|debt reduction)\b", 1.2),
    (r"\b(?:short squeeze|squeeze|breakout|gap up|new high|all-time high)\b", 1.2),
    (r"\b(?:bullish|upside|momentum|top gainer|top gainers)\b", 0.9),
])


BEARISH_PATTERNS = _compile([
    (r"\b(?:miss|misses|missed|falls short)\b.{0,28}\b(?:estimate|estimates|expectations|consensus|forecast)\b", 2.4),
    (r"\b(?:worse[-\s]?than[-\s]?expected|below[-\s]?consensus|below expectations)\b", 2.1),
    (r"\b(?:cuts?|cut|lowers?|lowered|reduces?|reduced|slashes?)\b.{0,28}\b(?:guidance|outlook|forecast|target|dividend|workforce|jobs)\b", 2.2),
    (r"\b(?:downgrade|downgraded|underperform|underweight|sell rating|initiates? at sell|price target cut|cuts? price target|lowers? price target)\b", 1.8),
    (r"\b(?:offering|stock offering|public offering|secondary offering|registered direct|atm offering|warrant|convertible note|convertible debt)\b", 1.7),
    (r"\b(?:prices?|priced|pricing)\b.{0,28}\b(?:offering|registered direct|public offering|notes?|warrants?)\b", 1.6),
    (r"\b(?:dilution|dilutive|reverse split|delisting|going concern)\b", 1.8),
    (r"\b(?:nasdaq|nyse|exchange)\b.{0,32}\b(?:noncompliance|deficiency|delisting notice|bid price)\b", 1.8),
    (r"\b(?:bankruptcy|chapter 11|insolvency|default|restructuring support agreement|liquidation)\b", 2.4),
    (r"\b(?:lawsuit|sued|class action|investigation|probe|subpoena|sec charges?|fraud|short seller report|short report)\b", 1.8),
    (r"\b(?:fda|regulator|regulatory)\b.{0,32}\b(?:rejects?|rejection|declines?|hold|clinical hold|complete response letter|crl|warning letter)\b", 2.3),
    (r"\b(?:failed|fails?|negative|disappointing|did not meet|does not meet|missed)\b.{0,28}\b(?:primary endpoint|secondary endpoint|trial|study|phase|endpoint|data|results|topline|top-line)\b", 2.0),
    (r"\b(?:recall|halt|halts?|suspends?|suspended|shutdown|outage|termination|terminated|withdraws?|withdrew|delay|delays|delayed|pauses?|paused)\b", 1.5),
    (r"\b(?:revenue|sales|earnings|profit|eps|margin)\b.{0,24}\b(?:fall|falls|fell|drop|drops|decline|declines|slump|slumps|decrease|decreases)\b", 1.6),
    (r"\b(?:warns?|warning)\b.{0,28}\b(?:revenue|sales|earnings|guidance|profit|margin|cash|liquidity)\b", 1.7),
    (r"\b(?:impairment|write[-\s]?down|material weakness|restatement|going concern doubt)\b", 1.8),
    (r"\b(?:loss|losses)\b.{0,24}\b(?:widens?|widened|larger|greater)\b", 1.7),
    (r"\b(?:stock|shares?)\b.{0,24}\b(?:crash|crashes|crashed|falls?|drops?|slumps?|plunges?|tumbles?|slides?|sinks?)\b", 1.6),
    (r"\b(?:crash|crashes|crashed|plunges?|tumbles?|sinks?)\b.{0,18}\b(?:stock|shares?|price)\b", 1.5),
    (r"\b(?:bearish|downside|risk-off|short report|fraud risk)\b", 0.9),
])


def _compile_events(patterns: list[tuple[str, str, float, str]]) -> list[EventPattern]:
    return [(event, re.compile(pattern, re.IGNORECASE), weight, reason) for event, pattern, weight, reason in patterns]


EVENT_PATTERNS = _compile_events([
    ("earnings_beat", r"\b(?:beat|beats|beating|tops|exceeds?)\b.{0,28}\b(?:estimate|estimates|expectations|consensus|forecast)\b", 2.4, "beat estimates"),
    ("earnings_beat", r"\b(?:better[-\s]?than[-\s]?expected|above[-\s]?consensus|ahead of expectations)\b", 2.1, "above expectations"),
    ("earnings_miss", r"\b(?:miss|misses|missed|falls short)\b.{0,28}\b(?:estimate|estimates|expectations|consensus|forecast)\b", -2.4, "missed estimates"),
    ("earnings_miss", r"\b(?:worse[-\s]?than[-\s]?expected|below[-\s]?consensus|below expectations)\b", -2.1, "below expectations"),
    ("guidance_raise", r"\b(?:raises?|raised|boosts?|boosted|lifts?|lifted)\b.{0,28}\b(?:guidance|outlook|forecast)\b", 2.2, "raised guidance/outlook"),
    ("guidance_cut", r"\b(?:cuts?|cut|lowers?|lowered|slashes?)\b.{0,28}\b(?:guidance|outlook|forecast)\b", -2.2, "cut guidance/outlook"),
    ("fda_approval", r"\b(?:fda|regulator|regulatory)\b.{0,32}\b(?:approval|approves?|clearance|clears?|authorized|accepted)\b", 2.3, "regulatory approval/clearance"),
    ("fda_approval", r"\b(?:clearance|approval|authorization|accepted|acceptance)\b.{0,32}\b(?:510\(k\)|ind|nda|bla|pma|fda|ema)\b", 2.2, "regulatory acceptance/clearance"),
    ("fda_designation", r"\b(?:fast track|breakthrough therapy|orphan drug|priority review|rare pediatric disease)\b.{0,24}\b(?:designation|granted|status|voucher)\b", 2.0, "regulatory designation"),
    ("fda_rejection", r"\b(?:fda|regulator|regulatory)\b.{0,32}\b(?:rejects?|rejection|declines?|hold|clinical hold|complete response letter|crl)\b", -2.3, "regulatory rejection/hold"),
    ("clinical_positive", r"\b(?:positive|successful|promising|met|meets?|achieved|achieves|sustained|durable|significant)\b.{0,32}\b(?:primary endpoint|secondary endpoint|trial|study|phase|endpoint|data|results|topline|top-line|improvement|efficacy|response)\b", 2.0, "positive clinical data"),
    ("clinical_positive", r"\b(?:primary endpoint|secondary endpoint)\b.{0,28}\b(?:met|achieved|statistically significant)\b", 2.2, "endpoint met"),
    ("clinical_negative", r"\b(?:failed|fails?|negative|disappointing|did not meet|does not meet|missed)\b.{0,28}\b(?:primary endpoint|secondary endpoint|trial|study|phase|endpoint|data|results|topline|top-line)\b", -2.0, "negative clinical data"),
    ("analyst_upgrade", r"\b(?:upgrade|upgraded|outperform|overweight|buy rating|initiates? at buy|initiates? coverage with buy|price target raised|raises? price target)\b", 1.8, "analyst upgrade/target raise"),
    ("analyst_downgrade", r"\b(?:downgrade|downgraded|underperform|underweight|sell rating|initiates? at sell|price target cut|cuts? price target|lowers? price target)\b", -1.8, "analyst downgrade/target cut"),
    ("public_offering", r"\b(?:stock offering|public offering|secondary offering|registered direct|atm offering|warrant|convertible note|convertible debt|dilution|dilutive)\b", -1.8, "financing/dilution"),
    ("partnership_contract", r"\b(?:wins?|won|awarded|selected|chosen|receives?|received|secures?|secured)\b.{0,28}\b(?:contract|award|order|purchase order|customer|program|tender|agreement)\b", 1.8, "contract/order award"),
    ("partnership_contract", r"\b(?:contract|award|purchase order|order|partnership|collaboration|supply agreement|strategic agreement|distribution agreement|license agreement|commercial agreement)\b", 1.1, "contract/partnership"),
    ("growth_catalyst", r"\b(?:growth catalyst|growth catalysts|major catalyst|major catalysts|transformational catalyst|strategic catalyst)\b", 1.2, "growth catalyst"),
    ("earnings_growth", r"\b(?:revenue|sales|earnings|profit|eps|margin|ebit|ebitda|operating income|net income)\b.{0,28}\b(?:double|doubles|doubled|triple|triples|tripled|rise|rises|rose|grow|grows|grew|jump|jumps|surge|surges)\b", 1.7, "financial results growth"),
    ("product_launch", r"\b(?:launches?|launched|commercializes?|commercialized|rolls out|expands?|expanded)\b.{0,32}\b(?:product|platform|service|market|program|operations|coverage|facility)\b", 1.2, "launch/expansion"),
    ("patent_ip", r"\b(?:patent|intellectual property)\b.{0,24}\b(?:granted|issued|allowed|allowance)\b", 1.3, "patent/IP"),
    ("insider_buying", r"\b(?:insider buying|insiders? buy|director buys|ceo buys|open market purchase)\b", 1.5, "insider buying"),
    ("buyback_dividend", r"\b(?:buyback|repurchase|dividend increase|special dividend)\b", 1.2, "shareholder return"),
    ("lawsuit_probe", r"\b(?:lawsuit|sued|class action|investigation|probe|subpoena|sec charges?|fraud|short seller report|short report)\b", -1.8, "legal/regulatory risk"),
    ("exchange_compliance", r"\b(?:nasdaq|nyse|exchange)\b.{0,32}\b(?:noncompliance|deficiency|delisting notice|bid price)\b", -1.8, "exchange compliance risk"),
    ("bankruptcy_default", r"\b(?:bankruptcy|chapter 11|insolvency|default|going concern|liquidation)\b", -2.4, "bankruptcy/default risk"),
    ("stock_move_up", r"\b(?:stock|shares?)\b.{0,24}\b(?:rockets?|soars?|surges?|jumps?|rall(?:y|ies)|gains?|pops?|climbs?)\b", 1.4, "shares moving higher"),
    ("stock_move_down", r"\b(?:stock|shares?)\b.{0,24}\b(?:crash|crashes|crashed|falls?|drops?|slumps?|plunges?|tumbles?|slides?|sinks?)\b", -1.6, "shares moving lower"),
    ("ipo_debut", r"\b(?:largest|historic|massive|successful)?\b.{0,24}\b(?:ipo|stock market debut|trading debut)\b", 1.1, "IPO/debut"),
    ("sec_filing", r"\b(?:form\s+)?(?:8-k|10-k|10-q|s-1|13d|13g|sec filing)\b", 0.0, "SEC filing"),
])


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _weighted_hits(text: str, patterns: list[Pattern]) -> tuple[float, int]:
    total = 0.0
    hits = 0
    for pattern, weight in patterns:
        matches = pattern.findall(text)
        if matches:
            total += weight * min(3, len(matches))
            hits += len(matches)
    return total, hits


SOCIAL_BULLISH_PATTERNS = _compile([
    (r"\b(?:loaded|loading|added|adding|accumulating|starter|starter position)\b", 0.7),
    (r"\b(?:calls?|call sweeps?|unusual call|otm calls?|bull flow)\b", 0.9),
    (r"\b(?:breakout|breaking out|base breakout|above vwap|held vwap|reclaim(?:ed|ing)?|support held|holds? support)\b", 1.1),
    (r"\b(?:break|breaks|breaking)\b.{0,18}\b(?:test|next|above|over|through|then)\b", 0.8),
    (r"\b(?:squeeze|short squeeze|gamma squeeze|low float|tiny float|float is locked|borrow fee|cost to borrow)\b", 1.1),
    (r"\b(?:gap up|runner|ripping|rips?|send(?:ing)?|sending it|next leg|higher highs?|new highs?)\b", 0.9),
    (r"\b(?:buy|buying|bought|long|bullish|bulls?|upside|momentum|watching for continuation)\b", 0.7),
    (r"\b(?:not selling|holding strong|diamond hands|bears? trapped|shorts? trapped|shorties?|shorts right)\b", 0.7),
    (r"\b(?:moon|to the moon|liftoff|rocket|push+|let'?s go|lfg|send it|game again)\b", 0.7),
    (r"\b(?:bounce|reversal|curl(?:ing)?|green|strong close|ah run|power hour|continuation|moving now)\b", 0.7),
    (r"\b(?:approval|clearance|contract|partnership|buyout|merger|acquisition|upgrade|beat|guidance raised)\b", 1.0),
])


SOCIAL_BEARISH_PATTERNS = _compile([
    (r"\b(?:puts?|put sweeps?|bear flow|short(?:ing)?|shorted|bearish)\b", 0.9),
    (r"\b(?:dump|dumping|rug|rug pull|exit liquidity|bagholder|bagholders|trap|bull trap|fake pump|pump and dump)\b", 1.0),
    (r"\b(?:breakdown|lost vwap|below vwap|resistance rejected|reject(?:ed|ing)?|lower highs?|head and shoulders)\b", 1.0),
    (r"\b(?:gap down|selloff|selling|sold|sell|avoid|stay away|dead|dead stock|dead cat|cooked|toast|done|falls? back)\b", 0.8),
    (r"\b(?:offering|dilution|dilute|diluting|warrants?|reverse split|rs incoming|delisting|halt|lawsuit|investigation)\b", 1.2),
    (r"\b(?:miss|downgrade|guidance cut|bankruptcy|going concern|crl|clinical hold)\b", 1.1),
    (r"\b(?:no squeeze|not bullish|won't run|will not run|overextended|overvalued|too late|very little movement|no momentum)\b", 0.9),
    (r"\b(?:atm|atm machine|ceiling|manipulation|scam|profit taking|taking profit|small profit|i'?m out|im out|trap doors? shut)\b", 0.7),
    (r"\b(?:red|crash|crashing|rugged|weak|bleeding|sell the news|another day)\b", 0.7),
])


SOCIAL_NEGATION_RE = re.compile(
    r"\b(?:not|no|never|without|fake|failed|fails?|won't|will not|cannot|can't)\b.{0,18}"
    r"\b(?:bullish|breakout|squeeze|run|runner|approval|buyout|moon|rip)\b",
    re.IGNORECASE,
)


SOURCE_BULLISH_RE = re.compile(r"\b(?:bull(?:ish)?|positive|up)\b", re.IGNORECASE)
SOURCE_BEARISH_RE = re.compile(r"\b(?:bear(?:ish)?|negative|down)\b", re.IGNORECASE)
CASHTAG_RE = re.compile(r"(?<![A-Z0-9])\$[A-Z][A-Z0-9.-]{0,9}", re.IGNORECASE)
WORD_RE = re.compile(r"[a-z][a-z'-]{1,}", re.IGNORECASE)
SOCIAL_NOISE_RE = re.compile(r"\b(?:trump|iran|nuke|saudi|war|politics|election|president)\b", re.IGNORECASE)
MARKET_RESEARCH_REPORT_RE = re.compile(
    r"\bmarket\s+(?:size|share|trends?|forecast|segmentation|analysis|outlook)\b"
    r".{0,140}\b(?:cagr|forecast|segmentation|swot|industry report|leaders report|analysis outlook)\b",
    re.IGNORECASE,
)
MARKET_MOVING_OVERRIDE_RE = re.compile(
    r"\b(?:fda|approval|clearance|contract|order|partnership|earnings|revenue|eps|guidance|"
    r"offering|dilution|delisting|downgrade|upgrade|trial|endpoint|merger|acquisition|buyout)\b",
    re.IGNORECASE,
)


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _signed_source_score(source_sentiment: object = None, source_score: object = None) -> float:
    """Normalize source labels into a non-binary prior instead of +/-1 votes."""
    if source_score is not None:
        try:
            raw = float(source_score)
            if math.isfinite(raw):
                raw = _clamp(raw)
                if abs(raw) > 0.75:
                    return 0.62 if raw > 0 else -0.62
                return raw
        except (TypeError, ValueError):
            pass

    label = str(source_sentiment or "").strip().lower()
    if SOURCE_BULLISH_RE.search(label):
        return 0.58
    if SOURCE_BEARISH_RE.search(label):
        return -0.58
    return 0.0


def _social_text_features(text: str, bullish_hits: int = 0, bearish_hits: int = 0) -> dict[str, object]:
    cashtags = CASHTAG_RE.findall(text or "")
    words = WORD_RE.findall(text or "")
    unique_words = {w.lower() for w in words}
    signal_hits = bullish_hits + bearish_hits
    non_ticker_words = [w for w in words if not w.startswith("$")]
    mostly_tickers = len(cashtags) >= 3 and len(non_ticker_words) <= 8 and signal_hits == 0
    unrelated_noise = bool(SOCIAL_NOISE_RE.search(text or "")) and signal_hits == 0
    return {
        "cashtags": len(cashtags),
        "words": len(words),
        "unique_words": len(unique_words),
        "mostly_tickers": mostly_tickers,
        "unrelated_noise": unrelated_noise,
    }


def _source_only_score(source_prior: float, text: str) -> tuple[float, list[str]]:
    """Convert a raw social-platform label into weak evidence when text has no signal."""
    if not source_prior:
        return 0.0, []

    sign = 1.0 if source_prior > 0 else -1.0
    features = _social_text_features(text)
    magnitude = 0.34
    signals = ["source_label_only"]

    if int(features["words"]) >= 6:
        magnitude += 0.04
        signals.append("readable_text")
    if int(features["words"]) >= 14 and int(features["unique_words"]) >= 8:
        magnitude += 0.03
        signals.append("context_text")
    if int(features["cashtags"]) <= 2 and int(features["words"]) >= 4:
        magnitude += 0.03
        signals.append("ticker_focused")
    if int(features["words"]) <= 2:
        magnitude -= 0.08
        signals.append("ticker_only")
    if bool(features["mostly_tickers"]):
        magnitude -= 0.08
        signals.append("multi_ticker_low_context")
    if bool(features["unrelated_noise"]):
        magnitude -= 0.10
        signals.append("off_topic_noise")

    return round(sign * _clamp(magnitude, 0.20, 0.46), 4), signals


def _financial_confidence_cap(text: str, total: float, hits: int, event_score: float) -> float:
    """Avoid over-certainty when a short headline has only one repeated clue."""
    unique_words = len(set(WORD_RE.findall(text)))
    cap = 0.86 + min(0.04, unique_words * 0.0025) + min(0.035, total * 0.006) + min(0.025, hits * 0.006)
    if abs(event_score) >= 2.2:
        cap += 0.025
    if unique_words >= 16:
        cap += 0.025
    return min(0.95, cap)


def _social_text_audit(text: str) -> dict[str, object]:
    clean_text = _clean(text).lower()
    if not clean_text:
        return {"label": "neutral", "score": 0.0, "confidence": 0.0, "signals": []}

    financial_label, financial_confidence = score_financial_sentiment(clean_text, "")
    financial_score = signed_sentiment_score(financial_label, financial_confidence)
    bullish, bullish_hits = _weighted_hits(clean_text, SOCIAL_BULLISH_PATTERNS)
    bearish, bearish_hits = _weighted_hits(clean_text, SOCIAL_BEARISH_PATTERNS)
    features = _social_text_features(clean_text, bullish_hits, bearish_hits)
    if SOCIAL_NEGATION_RE.search(clean_text):
        bearish += 0.7
        bearish_hits += 1

    total = bullish + bearish
    lexicon_score = 0.0
    if total > 0:
        directional = (bullish - bearish) / total
        evidence_strength = min(0.95, 0.42 + math.log1p(total) / math.log(12))
        lexicon_score = _clamp(directional * evidence_strength)

    if financial_score and lexicon_score:
        if financial_score * lexicon_score > 0:
            text_score = _clamp(0.55 * financial_score + 0.45 * lexicon_score)
        else:
            text_score = _clamp(0.35 * financial_score + 0.65 * lexicon_score)
    else:
        text_score = financial_score or lexicon_score

    hits = bullish_hits + bearish_hits
    confidence = 0.0 if abs(text_score) < 0.05 else min(
        0.95,
        0.34 + abs(text_score) * 0.42 + min(hits, 5) * 0.035 + min(total, 5.0) * 0.02,
    )
    if bool(features["mostly_tickers"]) or bool(features["unrelated_noise"]):
        text_score *= 0.35
        confidence *= 0.45
    if abs(text_score) < 0.12:
        label = "neutral"
    else:
        label = "bullish" if text_score > 0 else "bearish"

    signals = []
    if bullish_hits:
        signals.append(f"bullish_terms:{bullish_hits}")
    if bearish_hits:
        signals.append(f"bearish_terms:{bearish_hits}")
    if financial_label != "neutral":
        signals.append(f"financial_{financial_label}:{financial_confidence:.2f}")
    if bool(features["mostly_tickers"]):
        signals.append("multi_ticker_low_context")
    if bool(features["unrelated_noise"]):
        signals.append("off_topic_noise")

    return {
        "label": label,
        "score": round(text_score, 4),
        "confidence": round(confidence, 3),
        "signals": signals[:5],
    }


def classify_financial_event(title: str, content: str = "") -> tuple[str, float, str]:
    """Return event type, signed event score, and a compact reason."""
    text = _clean(f"{title} {content[:1000]}").lower()
    if not text:
        return "unknown", 0.0, ""

    best: tuple[str, float, str] | None = None
    for event_type, pattern, weight, reason in EVENT_PATTERNS:
        if pattern.search(text):
            if best is None or abs(weight) > abs(best[1]):
                best = (event_type, weight, reason)
    if best is None:
        return "general_news", 0.0, ""
    return best


def score_financial_sentiment(title: str, content: str = "") -> tuple[str, float]:
    """Return label plus positive confidence magnitude in [0, 0.95]."""
    text = _clean(f"{title} {content[:1000]}").lower()
    if not text:
        return "neutral", 0.0
    if MARKET_RESEARCH_REPORT_RE.search(text) and not MARKET_MOVING_OVERRIDE_RE.search(text):
        return "neutral", 0.0

    bullish, bullish_hits = _weighted_hits(text, BULLISH_PATTERNS)
    bearish, bearish_hits = _weighted_hits(text, BEARISH_PATTERNS)
    event_type, event_score, _event_reason = classify_financial_event(title, content)
    total = bullish + bearish
    hits = bullish_hits + bearish_hits
    if total <= 0:
        if abs(event_score) >= 1.0 and event_type not in {"sec_filing", "general_news", "unknown"}:
            length_factor = min(0.035, len(set(WORD_RE.findall(text))) * 0.0015)
            confidence = min(0.9, 0.45 + min(abs(event_score), 2.4) * 0.16 + length_factor)
            return ("bullish" if event_score > 0 else "bearish"), round(confidence, 3)
        return "neutral", 0.0

    raw = (bullish - bearish) / total
    if abs(raw) < 0.08 or abs(bullish - bearish) < 0.25:
        if abs(event_score) >= 1.2 and event_type not in {"sec_filing", "general_news", "unknown"}:
            length_factor = min(0.035, len(set(WORD_RE.findall(text))) * 0.0015)
            confidence = min(0.9, 0.42 + min(abs(event_score), 2.4) * 0.15 + min(total, 6.0) * 0.02 + length_factor)
            return ("bullish" if event_score > 0 else "bearish"), round(confidence, 3)
        return "neutral", 0.0

    length_factor = min(0.035, len(set(WORD_RE.findall(text))) * 0.0015)
    event_factor = 0.0 if event_type in {"sec_filing", "general_news", "unknown"} else min(0.025, abs(event_score) * 0.006)
    confidence = min(
        0.95,
        0.38 + abs(raw) * 0.42 + min(total, 8.0) * 0.025 + min(hits, 5) * 0.02 + length_factor + event_factor,
    )
    confidence = min(confidence, _financial_confidence_cap(text, total, hits, event_score))
    return ("bullish" if raw > 0 else "bearish"), round(confidence, 3)


def signed_sentiment_score(label: str, confidence: float) -> float:
    """Return signed sentiment score in [-1, 1] from label + confidence."""
    clean_label = str(label or "").lower()
    value = max(0.0, min(1.0, float(confidence or 0.0)))
    if clean_label == "bullish":
        return round(value, 4)
    if clean_label == "bearish":
        return round(-value, 4)
    return 0.0


def sentiment_audit(title: str, content: str = "") -> dict[str, object]:
    label, confidence = score_financial_sentiment(title, content)
    event_type, event_score, event_reason = classify_financial_event(title, content)
    signed_score = confidence if label == "bullish" else -confidence if label == "bearish" else 0.0
    return {
        "label": label,
        "confidence": confidence,
        "score": signed_score,
        "event_type": event_type,
        "event_score": event_score,
        "event_reason": event_reason,
    }


def audit_social_sentiment(
    text: str,
    source_sentiment: object = None,
    source_score: object = None,
) -> dict[str, object]:
    """Validate source social labels against text evidence and return a continuous score."""
    text_audit = _social_text_audit(text)
    text_score = float(text_audit["score"] or 0.0)
    source_prior = _signed_source_score(source_sentiment, source_score)

    if source_prior and text_score:
        if source_prior * text_score > 0:
            final_score = _clamp(0.48 * source_prior + 0.52 * text_score)
            agreement = "confirmed"
            agreement_boost = 0.08
        else:
            final_score = _clamp(0.30 * source_prior + 0.70 * text_score)
            agreement = "source_text_disagree"
            agreement_boost = -0.08
    elif text_score:
        final_score = text_score
        agreement = "text_only"
        agreement_boost = 0.0
    elif source_prior:
        final_score, source_signals = _source_only_score(source_prior, text)
        text_audit["signals"] = list(text_audit["signals"]) + source_signals
        agreement = "source_only"
        agreement_boost = -0.08
    else:
        final_score = 0.0
        agreement = "neutral"
        agreement_boost = 0.0

    confidence = min(
        0.95,
        max(
            0.0,
            float(text_audit["confidence"] or 0.0) * 0.78
            + (0.18 if source_prior else 0.0)
            + agreement_boost,
        ),
    )
    if abs(final_score) < 0.12:
        label = "neutral"
    else:
        label = "bullish" if final_score > 0 else "bearish"

    return {
        "method": "financial_social_validation_v1",
        "label": label,
        "score": round(final_score, 4),
        "confidence": round(confidence, 3),
        "agreement": agreement,
        "source_label": str(source_sentiment or "").lower() or None,
        "source_score": round(source_prior, 4),
        "text_label": text_audit["label"],
        "text_score": text_audit["score"],
        "text_confidence": text_audit["confidence"],
        "signals": text_audit["signals"],
    }


def score_social_sentiment(text: str) -> tuple[str, float]:
    """Return label plus signed continuous score in [-1, 1] for social posts."""
    audit = audit_social_sentiment(text)
    return str(audit["label"]), float(audit["score"] or 0.0)
