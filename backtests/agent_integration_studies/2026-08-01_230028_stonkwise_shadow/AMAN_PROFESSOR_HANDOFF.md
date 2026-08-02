# Aman / Professor Handoff

StonkWise was reviewed at the implementation level and compared with current FlashFeed rather than copied as a second application. Its useful surviving ideas are Agent orchestration, macro-event context, and evidence-oriented reports. Its FastAPI/SQLite/Jinja stack, separate ingestion, narrow ticker store, broad keyword rules, permissive model JSON parsing, and raw-text prompt handling should not be ported.

A local, disabled-by-default, read-only Catalyst Intelligence prototype now uses FlashFeed's approved articles, causal timestamps, ticker universe, event deduplication, strict schemas, source evidence, separate severity/direction/directness, and deterministic model fallback. It has no trading functions and cannot alter thresholds. The study examined 108,700 articles, produced 6,139 deduplicated structured events after collapsing 1,092 syndications, generated 174 non-causal price-context rows, and tested seven preregistered catalyst questions on 558 frozen simulated positions.

The methodology exposed two important limits. First, no independent human labels exist, so no classifier precision is being claimed. Second, the positions cover only 3 dates; the apparent temporal test is not independent enough for prediction evidence. Broad “any catalyst” filtering selected every entry, while direct, aligned, contradiction, and macro filters did not produce a robust test improvement.

**Recommendation:** use the prototype only for a local explanatory demo, ideally an expandable “Why this ticker?” panel in Decision Map and later Positions. Have a reviewer label the supplied sample, then run a frozen later-period check. Keep all production prediction, entry, exit, and position policies unchanged.
