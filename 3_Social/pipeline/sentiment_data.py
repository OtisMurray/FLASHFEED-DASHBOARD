"""D5: Sentiment lexicon data.

Bullish/bearish phrases, words, and emojis with signal-strength weights
(0.0–1.0).  Used by ``sentiment_engine`` to score posts.
"""

# ---------------------------------------------------------------------------
# Multi-word phrases — matched as substrings on lowercased text.
# Higher weight = stronger signal.
# ---------------------------------------------------------------------------

BULLISH_PHRASES: dict[str, float] = {
    "to the moon": 0.9,
    "diamond hands": 0.9,
    "buy the dip": 0.8,
    "going up": 0.5,
    "let's go": 0.4,
    "strap in": 0.6,
    "buckle up": 0.5,
    "moon mission": 0.9,
    "easy money": 0.7,
    "free money": 0.7,
    "can't go tits up": 0.8,
    "tendies incoming": 0.8,
    "short squeeze": 0.7,
    "gamma squeeze": 0.7,
    "all in": 0.6,
    "going long": 0.6,
    "calls printing": 0.8,
    "price target": 0.4,
    "strong buy": 0.9,
    "very bullish": 0.9,
    "extremely bullish": 1.0,
    "super bullish": 0.9,
    "looking good": 0.4,
    "huge upside": 0.8,
    "massive upside": 0.8,
    "ready to pop": 0.7,
    "about to explode": 0.7,
    "printing money": 0.8,
    "bull run": 0.7,
    "gap up": 0.6,
    "break out": 0.5,
    "new ath": 0.7,
    "all time high": 0.7,
}

BEARISH_PHRASES: dict[str, float] = {
    "paper hands": 0.7,
    "going down": 0.5,
    "rug pull": 0.9,
    "dead cat bounce": 0.8,
    "bag holder": 0.7,
    "bag holding": 0.7,
    "puts printing": 0.8,
    "crash incoming": 0.9,
    "get out now": 0.8,
    "sell everything": 0.9,
    "going to zero": 0.9,
    "strong sell": 0.9,
    "very bearish": 0.9,
    "extremely bearish": 1.0,
    "super bearish": 0.9,
    "huge downside": 0.8,
    "massive downside": 0.8,
    "about to tank": 0.8,
    "bear market": 0.6,
    "gap down": 0.6,
    "red flag": 0.5,
    "over valued": 0.6,
    "overvalued": 0.6,
    "pump and dump": 0.8,
    "ponzi scheme": 0.9,
    "loss porn": 0.5,
    "circuit breaker": 0.7,
    "margin call": 0.7,
    "new low": 0.6,
    "all time low": 0.7,
}

# ---------------------------------------------------------------------------
# Single words — matched with \b word boundaries on lowercased text.
# ---------------------------------------------------------------------------

BULLISH_WORDS: dict[str, float] = {
    "bullish": 0.8,
    "moon": 0.6,
    "mooning": 0.7,
    "calls": 0.4,
    "long": 0.3,
    "buy": 0.4,
    "buying": 0.4,
    "bought": 0.3,
    "tendies": 0.6,
    "undervalued": 0.6,
    "breakout": 0.5,
    "rally": 0.5,
    "rip": 0.4,
    "pump": 0.4,
    "yolo": 0.5,
    "hodl": 0.6,
    "rocket": 0.5,
    "squeeze": 0.5,
    "launch": 0.4,
    "soar": 0.6,
    "surge": 0.5,
    "gains": 0.4,
    "green": 0.3,
    "cheap": 0.3,
    "upside": 0.5,
}

BEARISH_WORDS: dict[str, float] = {
    "bearish": 0.8,
    "puts": 0.4,
    "short": 0.3,
    "sell": 0.4,
    "selling": 0.4,
    "sold": 0.3,
    "dump": 0.5,
    "dumping": 0.6,
    "crash": 0.6,
    "crashing": 0.7,
    "tank": 0.5,
    "tanking": 0.6,
    "drill": 0.5,
    "drilling": 0.6,
    "bleeding": 0.5,
    "red": 0.3,
    "rekt": 0.7,
    "wrecked": 0.5,
    "scam": 0.7,
    "fraud": 0.7,
    "bubble": 0.5,
    "worthless": 0.8,
    "bankrupt": 0.8,
    "bankruptcy": 0.8,
    "downside": 0.5,
    "plummet": 0.7,
}

# ---------------------------------------------------------------------------
# Emojis
# ---------------------------------------------------------------------------

BULLISH_EMOJIS: dict[str, float] = {
    "🚀": 0.7,
    "🌙": 0.5,
    "💎": 0.6,
    "🙌": 0.4,
    "💰": 0.4,
    "🤑": 0.5,
    "📈": 0.6,
    "🔥": 0.4,
    "💪": 0.4,
    "🐂": 0.6,
    "✅": 0.3,
    "🎉": 0.3,
    "💸": 0.4,
    "⬆️": 0.4,
}

BEARISH_EMOJIS: dict[str, float] = {
    "📉": 0.6,
    "💀": 0.5,
    "🐻": 0.6,
    "🤡": 0.5,
    "😭": 0.4,
    "🩸": 0.5,
    "⚠️": 0.3,
    "🗑️": 0.5,
    "⬇️": 0.4,
    "❌": 0.4,
    "☠️": 0.5,
}
