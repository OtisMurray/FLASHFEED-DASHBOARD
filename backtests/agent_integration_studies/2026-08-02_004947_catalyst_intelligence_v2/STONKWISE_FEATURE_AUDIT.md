# StonkWise Feature Audit

## Scope and versions

The implementation, tests, configuration, dependencies, and UI were inspected at StonkWise commit `fe14c61ac7bd19a95dcec6c34e5cc4019f662dda`; this is not a README-only review. The comparison target is FlashFeed commit `2593eb6a8747bd7caa6a4dd03afb5063b1984f26`. StonkWise Python source passed `compileall`. Its full pytest suite could not run because the isolated host lacks its Python dependency stack, including pytest, SQLAlchemy, Pydantic, Torch, and Transformers. No dependency or model download was performed.

## Architecture

StonkWise is a FastAPI/Jinja/Alpine application backed by SQLAlchemy and SQLite. APScheduler invokes ingestion and analysis tasks. That architecture is internally coherent but incompatible with FlashFeed's Node/Express, MongoDB, Redis, React, and existing worker design. It should be treated as an algorithm/concept source, not imported as a second application.

## Agent generation path

- `app/agent/triggers.py` evaluates a recent ticker snapshot using news, social, relative-volume, and sentiment conditions, then applies a cooldown. The trigger concept is reusable, but FlashFeed already has ranked candidates and should supply the trigger. The cooldown uses `.seconds` rather than `.total_seconds()`, which can behave incorrectly across day boundaries.
- `app/agent/synthesizer.py` gathers recent news, social messages, Finviz fundamentals, price context, and energy macro context before creating an Agent report. The orchestration concept is useful; all reads must be replaced with existing FlashFeed collections and schemas.
- `app/agent/prompts.py` places article and social text directly into the model prompt. It does not clearly isolate untrusted text from instructions and therefore carries prompt-injection risk. News and social citation numbering both restart at one, making references ambiguous.
- `app/agent/client.py` supports Ollama, Groq, and Hugging Face. JSON extraction relies on finding an object-shaped substring and validation is too narrow. Tickers, confidence, timestamps, evidence IDs, and unsupported claims are not strongly validated.
- `app/agent/settings.py` makes provider behavior configurable, but there is no useful deterministic catalyst fallback when a provider is unavailable.
- Agent reports are stored through SQLAlchemy models and exposed through `app/api/agent.py`. The reporting concept can be rewritten as a separate read-only Mongo shadow collection.

## Macro and geopolitical path

- `app/macro/classifier.py` applies keyword fragments to identify geopolitical events. Broad substrings such as `fed`, `freeze`, `hostage`, and `sanction` lack entity, negation, and context handling and can produce false positives.
- `app/macro/events.py` stores MarketEvents and expiration state, but event identity, source-document traceability, first-seen time, and cross-feed deduplication are insufficient for causal research. Repeated scheduling can recreate equivalent events.
- `app/macro/commodities.py`, `correlation.py`, and `energy.py` provide commodity changes, ETF relationships, and the Energy Risk Score. These are useful research concepts, but the score emphasizes absolute movement and event density. It does not express who benefits, who is harmed, confidence, or horizon.
- `app/macro/synthesizer.py` combines event and market context. This should be generalized into explicit asset-sector effects rather than treating a high risk score as a directional signal.

## Pipeline, ingestion, NLP, and analytics

- `app/pipeline/normalize.py`, `enrich.py`, `schema.py`, `rank.py`, `storage.py`, and `orchestrator.py` form a readable ingestion pipeline. Their concepts are mostly already implemented more completely in FlashFeed.
- `app/pipeline/dedupe.py` performs basic exact-source or same-batch title deduplication. It does not reliably collapse event-level syndication across feeds and time.
- `app/ingestion/` independently reads RSS, StockTwits, Bluesky, and Finviz. Porting these would duplicate FlashFeed collectors, source policy, scheduling, caching, and data stores.
- `app/nlp/tickers.py` uses an S&P 500 list and aliases, which is narrower than FlashFeed's stored listed-US screener universe. `app/nlp/sentiment.py` introduces another transformer sentiment path even though FlashFeed already has weighted social and article sentiment.
- `app/analytics/` duplicates indicators, correlation, momentum, and screener behavior that FlashFeed already owns.
- `app/models.py`, `app/api/`, and the Jinja UI are tied to the SQLite application and should not be ported.

## Configuration, sources, dependencies, and licensing

StonkWise config includes providers and sources that are not automatically approved for FlashFeed. CNBC, MarketWatch, Yahoo Finance articles, Seeking Alpha, and aggressive Finviz access must not be introduced merely because they appear in StonkWise. Local Ollama would add model storage, memory, startup, and latency demands that are not established as practical on Railway. The README describes the project as MIT, but the inspected clone contains no standalone LICENSE file; conceptual adaptation is safer until licensing is clarified.

## Reuse decision

- **Reuse mostly as-is:** no subsystem should be copied wholesale.
- **Adapt conceptually:** Agent orchestration, optional provider abstraction, event expiration, commodity/ETF context, and evidence-oriented reports.
- **Rewrite for FlashFeed:** catalyst taxonomy, entity/ticker/sector mapping, causal timestamps, event deduplication, strict output validation, prompt safety, persistence, APIs, and UI.
- **Already duplicated by FlashFeed:** ingestion, sentiment, screener, indicators, OHLC, fundamentals, ticker universe, persistence, scheduling, and candidate/position views.
- **Not useful:** the parallel FastAPI/SQLite/Jinja application boundary.
- **Unsafe or unreliable:** raw-text prompting, permissive JSON parsing, broad substring classification, ambiguous citations, and severity-as-direction.
- **Requires evidence:** Energy Risk Score, commodity-to-sector effects, optional LLM classification, and any strategy use.

The row-level decision matrix is in `FEATURE_REUSE_MATRIX.csv`.
