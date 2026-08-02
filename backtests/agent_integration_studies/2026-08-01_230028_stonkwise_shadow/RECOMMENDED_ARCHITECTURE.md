# Recommended Architecture

## Decision

Choose **Option 2: a read-only, shadow-mode Catalyst Intelligence Agent**. The strongest technically defensible StonkWise use is explanation, deduplication, and evidence organization. The current evidence does not justify prediction influence.

## Boundary

The Agent reads existing FlashFeed articles and screener metadata, preserves causal time, validates symbols, creates directional asset/sector effects, collapses syndication, and writes versioned structured records to a separate shadow collection. An optional model may summarize only supplied evidence and must pass the strict output schema. If it times out or fails validation, the deterministic record remains usable.

The Agent must not own ingestion, source policy, sentiment, OHLC, the screener universe, ranking, thresholds, positions, or scheduling. It must not import or invoke any trade-policy function. Its feature flag defaults off.

## Placement

Place the first UI in the existing Decision Map candidate details as an expandable “Why this ticker?” section, then reuse it in Positions. This is better than a new top-level page because the explanation is useful where the user is already evaluating a candidate. Show source links, evidence, timestamps, directness, horizon, confidence, and uncertainty.

## Evidence gate

The prototype is ready for a local explanatory demonstration only. Before any deployed shadow service, a reviewer must label the supplied sample, mapping/category/direction metrics must be calculated from those labels, and a frozen later-period run must show acceptable unsupported-claim and latency rates. Predictive use requires a much longer, date-separated frozen evaluation and is not currently supported.
