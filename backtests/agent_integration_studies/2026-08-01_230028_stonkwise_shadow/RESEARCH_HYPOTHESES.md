# Preregistered Catalyst Hypotheses

Created before the historical position outcomes were queried.

The entry and exit policies are frozen. These variants only ask whether a read-only catalyst field would have selected a different subset of already-recorded simulated positions. No threshold is optimized.

1. **Explanation only:** retain every frozen position. This is the non-strategy baseline.
2. **Any verified catalyst:** require at least one approved-source, causally available, deduplicated catalyst in the preceding 72 hours.
3. **Direct catalyst:** require a catalyst explicitly mapped to the ticker rather than a market-wide or sector-only relationship.
4. **Aligned high-confidence catalyst:** require confidence of at least 0.85 and catalyst direction aligned with the recorded AI direction.
5. **Reject capital-structure risk:** retain the baseline except when an offering, dilution, warrant, conversion, or reverse-split catalyst is present.
6. **Reject contradiction:** retain the baseline except when a direct high-confidence catalyst contradicts the recorded AI direction.
7. **Affected-sector macro context:** require a market-wide catalyst whose predeclared affected-sector mapping includes the ticker's stored screener sector.

Development is the earliest 60% of entries, validation the next 20%, and the final 20% is an untouched temporal test. The variants are not retuned after viewing validation or test results. Selection is not based on mean return alone; trade count, median return, profit factor, drawdown, concentration, and consistency across validation and test are considered.

These are exploratory filters, not production policies. A positive result does not establish causation and cannot authorize a live policy change.
