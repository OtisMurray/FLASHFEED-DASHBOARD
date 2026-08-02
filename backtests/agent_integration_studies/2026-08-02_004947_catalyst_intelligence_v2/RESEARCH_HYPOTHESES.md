# Pre-Registered Catalyst Intelligence V2 Checks

These checks were fixed before querying historical outcomes. They validate the
local production-shaped module; they do not optimize entry or exit thresholds.

1. **Explanatory baseline:** keep every frozen position and attach evidence only.
2. **Any verified catalyst:** require at least one causal structured direct or
   macro event. This is expected to be non-discriminating if broad macro events
   are common.
3. **Direct catalyst:** require a causal event mapped directly to the ticker.
4. **Aligned high-confidence catalyst:** require a direct event with confidence
   at least 0.85 and direction aligned with the frozen AI suggestion.
5. **Reject capital-structure risk:** exclude entries with causal offering,
   dilution, warrant, conversion, or reverse-split evidence.
6. **Reject contradiction:** exclude an entry when a high-confidence direct
   event opposes the frozen AI direction.
7. **Affected-sector macro:** require a causal market-wide event whose mapped
   sector matches the frozen entry sector.

Primary product-quality checks are deterministic output, approved-source
compliance, causal timestamps, ticker-universe validation, duplicate reduction,
inspectable citations, and safe failure without an LLM. Strategy outputs are
descriptive research only. No policy may be promoted from this run.
