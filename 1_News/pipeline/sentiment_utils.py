"""Shared lightweight financial sentiment scoring.

This is intentionally deterministic and fast for ingestion. It catches common
market-moving phrases before any slower LLM/FinBERT batch scorer is added.
"""

from __future__ import annotations

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

    bullish, bullish_hits = _weighted_hits(text, BULLISH_PATTERNS)
    bearish, bearish_hits = _weighted_hits(text, BEARISH_PATTERNS)
    event_type, event_score, _event_reason = classify_financial_event(title, content)
    total = bullish + bearish
    if total <= 0:
        if abs(event_score) >= 1.0 and event_type not in {"sec_filing", "general_news", "unknown"}:
            confidence = min(0.9, round(0.45 + min(abs(event_score), 2.4) * 0.16, 2))
            return ("bullish" if event_score > 0 else "bearish"), confidence
        return "neutral", 0.0

    raw = (bullish - bearish) / total
    if abs(raw) < 0.08 or abs(bullish - bearish) < 0.25:
        if abs(event_score) >= 1.2 and event_type not in {"sec_filing", "general_news", "unknown"}:
            confidence = min(0.9, round(0.42 + min(abs(event_score), 2.4) * 0.15 + min(total, 6.0) * 0.02, 2))
            return ("bullish" if event_score > 0 else "bearish"), confidence
        return "neutral", 0.0

    hits = bullish_hits + bearish_hits
    confidence = min(0.95, round(0.38 + abs(raw) * 0.42 + min(total, 8.0) * 0.025 + min(hits, 5) * 0.02, 2))
    return ("bullish" if raw > 0 else "bearish"), confidence


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


def score_social_sentiment(text: str) -> tuple[str, float]:
    """Return label plus signed score in [-1, 1] for social posts."""
    label, confidence = score_financial_sentiment(text, "")
    if label == "bullish":
        return label, confidence
    if label == "bearish":
        return label, -confidence
    return label, 0.0
