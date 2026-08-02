# High-Mover Catalyst Validation Study

## Question

Can the StonkWise-inspired Catalyst Intelligence layer improve FlashFeed by validating and reranking the existing AI system's highest-upside targets, rather than replacing the current strategy?

## Verdict

**exploratory incremental signal promising requires frozen forward validation.**

This is a local shadow-ranking result only. It does not support a production policy change.

## Data and method

- 558 causal frozen AI observations were collapsed to 67 first ticker/date observations.
- 62 unique ticker/date candidates had at least ten real one-minute regular-session OHLC bars after the usable signal.
- Premarket suggestions were measured from the first regular-session open; after-close suggestions were excluded.
- The target is maximum favorable excursion after the signal, which directly tests whether a candidate became a major mover.
- The existing AI score remains the base. Catalyst evidence contributes a bounded signed adjustment: aligned evidence can promote, opposing evidence can caution, and watch candidates are no longer falsely treated as contradictions.
- The frozen catalyst weight was 0.2.

## Retrospective top-5 sensitivity

| Review date | AI MFE | Assisted MFE | MFE delta | AI 10% precision | Assisted 10% precision | Close-return delta |
|---|---:|---:|---:|---:|---:|---:|
| July 30 | 10.93% | 35.59% | 24.66 pp | 60.00% | 80.00% | 19.23 pp |
| July 31 | 5.78% | 6.79% | 1.01 pp | 40.00% | 40.00% | 3.48 pp |

## Interpretation

The intended role is narrow: FlashFeed AI discovers candidates; catalyst intelligence adds evidence-aware validation for candidates already near the top. It is not an entry gate and does not replace AI scoring. Market-wide events are excluded from the bonus because they did not distinguish candidates in the earlier study.

The expanded rules recovered genuine causal clinical-development, supplier-agreement, and plural partnership language. However, those rules were added after reviewing missed movers. Therefore neither review date is an untouched test. These numbers demonstrate mechanism and retrospective plausibility only. The large July 30 improvement is concentrated in GCTK, so `leave_one_promoted_out.csv` must be read alongside the headline result. A frozen forward session is required before claiming predictive improvement.

## Safety

No ranking, threshold, entry, exit, position, deployment, or production policy was changed by this study.
