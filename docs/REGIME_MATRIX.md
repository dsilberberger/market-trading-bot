# Regime Matrix & Base Budget Policy (deterministic)

Source (pasted): the system has orthogonal regime axes, deterministic from Round-1 features + macro policy summary. Regime labels inform policy only; they do not place trades directly.

## Regime axes
- Equity regime: label `risk_on|neutral|risk_off`, confidence 0–1; supports trend/returns/drawdown/vol buckets.
- Volatility regime: label `low|rising|stressed`, confidence; supports realized vol/percentiles/delta.
- Rates/policy regime: label `rising|stable|falling` plus stance `restrictive|neutral|accommodative`; confidence; supports rates series + lag-aware macro policy summary.
- Breadth/participation: label `broad|concentrated|unknown`; supports breadth proxy.
- Cross-asset leader: label `equities|bonds|gold|cash`; supports relative strength across key sleeves.

## Base budget allocation
Base sleeve budget is an exposure cap: `baseBudgetUSD = equityUSD * baseExposureCapPct`.

Baseline mapping (driven primarily by equity regime confidence):

| Equity confidence | Base exposure cap | Interpretation                   |
|-------------------|-------------------|----------------------------------|
| < 0.35            | 35%               | low conviction ⇒ probe only      |
| 0.35–0.60         | 60%               | moderate conviction ⇒ participate|
| ≥ 0.60            | 100% (clip by global max if any) | high conviction ⇒ fully invest |

Deterministic dampeners:
- Vol regime stressed ⇒ reduce cap (e.g., to 35% or lower).
- Macro lag/coarse percentiles ⇒ may reduce confidence (indirectly reducing cap).
- Transition risk high ⇒ reduce cap or slow pacing.

## Dislocation overlay relationship
- Base cap stays unchanged during dislocation (base posture remains).
- Dislocation adds a separate proxy-only overlay budget on top, bounded by a total max cap (e.g., 70%).
- Example: base cap 35%, dislocation overlay +30%, total clipped by `maxTotalExposureCapPct` (e.g., 70%).

## Summary in one line
Base budget is driven primarily by equity regime confidence, dampened by vol/policy/transition risks, and converted to an exposure cap % that sets the maximum base sleeve dollars deployed each week. Dislocation overlay is additive (up to the total cap), and options sleeves are independent in reserve.
