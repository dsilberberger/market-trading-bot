# Simulation & Dry-Run Notes — 2026-01-06

Persistent reference for current tuning, invariants, and recent runs (live dry-run + synthetic harness scenarios).

## Active Config / Tuning
- Capital split: corePoolPct 0.70, reservePoolPct 0.30.
- Base caps: risk_off 0.35; neutral 0.70; risk_on 0.95; fallback 0.50.
- Confidence scaling: deployConfThreshold 0.50; deployConfScaleLow 0.95 (scale never > 1.0).
- Time-in-regime ramp: minWeeks 0, maxWeeks 1.
- Confidence calibration: minHistoryDays 120; coverageFloorConfidence 0.55.
- Universe (canonical): VTI, VXUS, VTV, USMV, SHY, IEF, TIP.
- Execution proxies: VTI→ITOT; VXUS→IXUS; VTV→(none); USMV→(none); SHY→VGSH/SCHO/SHV; IEF→SCHR/VGIT; TIP→SCHP/VTIP. Proxies are execution-only.
- Confidence proxies: VTI→ITOT, VXUS→IXUS, USMV→SPLV (confidence/lookback only; never used for targets or execution).
- 70/30 wall intact; options sleeves unchanged.
- Growth convexity gating tightened: requires risk_on, confidence ≥ 0.6, timeInRegimeWeeks ≥ 2, vol not stressed, and no dislocation.
- Planner: whole-share; remainder pass now only when risk_on and timeInRegimeWeeks ≥ 1 (reduces leftover cash in recovery only); still capped by deployBudget and 70/30.

## Live Dry-Run (no execution) — Run 2026-01-06T20-36
- Mode: live, dry-run, force; providers live (ETRADE quotes/balances).
- Account snapshot: NAV ~$2,811.27.
  - Core pool: $1,967.90
  - Reserve pool: $843.38
  - Base regime: neutral
  - Raw confidence: ~0.206 (signal strength), confidenceQuality: full (data adequacy)
  - confidenceScale: 0.95 (since confidence < 0.50 threshold? actually above? still scaled to 0.95 per config)
  - baseCap: 0.65 → deployPct: ~0.6175
  - Deploy budget: $1,215.18 (corePool * deployPct)
- Planned ETF buys (whole-share):
  - VTI: ~$341.31
  - VXUS: ~$310.62
  - IEF: ~$288.74
  - Spend: ~$940.67
  - Leftover: ~$274.51 (within budget; no redistribution)
- Invariants: spend <= deployBudget; whole-share only; proxies execution-only; role-based targets preserved.
- Reporting: anchor* fields (no SPY); base cap, confidence scale, deployPct printed; role-based rationale.

## Synthetic Harness Scenarios (harness-only, not live)
- Starting capital: $350,000; no contributions; weekly cadence.
- GFC-style (2007–2010 synthetic; 156 weeks):
  - Bot: end ~$319.9k; peak ~$356.9k; min ~$319.4k.
  - Regimes: RISK_OFF 86w; NEUTRAL 42w; RISK_ON 28w.
  - Dislocation: ADD 2w; HOLD 10w; REINTEGRATE 2w.
  - Insurance: opened once on rising edge. Growth options: opened 4× in risk_on.
  - Behavior: defended in crash; rebound muted due to higher cash.
  - Aggressive_robo (comparison profile): end ~$249.0k; min ~$243.5k; max ~$352.9k.

- 3-year synthetic scenarios vs aggressive_robo (same $350k start):
  - WHIPSAW_SIDEWAYS:
    - Bot end 360.8k (min 329.8k / max 369.8k)
    - Robo end 350.6k (min 325.7k / max 359.2k)
  - MULTI_SHOCK:
    - Bot end 358.3k (min 333.2k)
    - Robo end 344.7k (min 329.3k)
  - SLOW_GRIND_DOWN:
    - Bot end 304.5k (min 304.5k)
    - Robo end 309.4k
  - STEADY_BULL (conservative upward drift with defensive drag):
    - Bot end 254.9k (min 226.8k)
    - Robo end 259.5k (min 230.4k)
    - Note: scenario not a true historical bull; assumed muted returns/defensive drag, so both under-start.

## Behavioral Notes / Invariants
- Budget safety: enforced; no spend > deployBudget observed after fixes.
- Role allocations: preserved; proxies used only for execution when canonical unaffordable.
- Confidence: Quality “full” = data adequacy OK; raw confidence reflects signal strength (can be low even when quality is full).
- Leftover cash: retained when whole-share rounding prevents full deployment; no second-pass redistribution by design.
- Options sleeves unchanged; growth/insurance open per existing gates; reserve ledger isolated from core.

## Open Questions / Possible Next Steps
- Historical replay: synthetic scenarios are not true historical replays; for realistic bull/bear paths, integrate historical price series.
- Steady bull tuning: adjust scenario assumptions if a truer bull test is desired.
- Reporting clarity: keep emphasizing distinction between confidenceQuality (data) vs confidence (signal strength).
- Redistribute leftover? Currently single-pass; any change would be a behavior change (not yet requested).
