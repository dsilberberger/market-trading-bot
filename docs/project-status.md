# Project Status & Context

Last updated: 2026-03-31

## Current Validation Candidate
- Core baseline:
  - `85/15` capital lanes
  - smoothed exposure-cap mapping
  - current dislocation sleeve
  - growth off by default
- Secondary overlay candidate:
  - same system plus the narrow `M4` growth sleeve
- Insurance sleeve:
  - replay plumbing exists
  - currently not justified as part of the main architecture
- Dislocation handoff:
  - implemented safely
  - not yet treated as a primary baseline differentiator

## Key Architecture State
- Capital lanes are now operationally separate:
  - `85%` core capital for ETF activity, including dislocation ETF deployment
  - `15%` options reserve for option sleeves only
- Planner and replay use the same lane semantics:
  - `coreCapitalUsd`, `coreCashUsd`
  - `optionsReserveCapitalUsd`, `optionsReserveCashUsd`
  - `executedOptionReserveUsageUsd`
- Exposure cap is smoothed in `risk_on` and `neutral + low vol` states:
  - `confidence <= 0.5 -> 0.35`
  - `confidence >= 0.8 -> 1.0`
  - linear ramp in between
- Conservative rails remain unchanged in defensive states.

## What Is Driving Results Now
- Primary edge: ETF/dislocation system.
- Biggest improvements came from:
  - shrinking the oversized options reserve from `30%` to `15%`
  - smoothing confidence cliffs in the exposure cap
- Growth sleeve is additive in some recovery windows, but narrow and optional.
- Insurance sleeve is not part of the recommended baseline.

## Growth Sleeve Decision
- Final status: keep only as a narrow, optional, research-only overlay.
- Recommended retained config is `M4`:
  - `confidenceMin: 0.70`
  - `minTimeInRegimeWeeks: 3`
  - `minMoneyness: 1.01`
  - `maxMoneyness: 1.04`
  - `minMonths: 5`
  - `maxMonths: 7`
  - `initialTranchePct: 0.05`
  - `maxTotalPct: 0.12`
- Keep it feature-flagged, not default-on.

## Insurance Sleeve Decision
- Trigger/lifecycle/capital-plumbing fixes were implemented in replay.
- Result: the sleeve is now mechanically correct, but still not justified as part of the main system.
- Current recommendation:
  - do not include insurance in the primary validation candidate
  - reconsider only later if broader validation points to a specific downside gap worth hedging

## Re-Entry / Recovery Status
- Major re-entry friction has been addressed through:
  - `85/15` capital rebalance
  - smoothed exposure-cap mapping
- Current view:
  - no further immediate re-entry tuning is justified
  - if revisited later, dislocation handoff remains the narrowest residual area

## Broader Validation Status
- Grounded windows already exercised locally:
  - `2007–2009`
  - `2020–2022`
- Requested next windows:
  - `2010–2015`
  - `1998–2003`
  - `2016–2019`
- Current blocker:
  - no local real historical bar bundles or bar cache for those windows

## New Historical Bundle Tooling
- Real-history bundle converter:
  - [scripts/buildHistoricalReplayBundle.ts](/Users/dsilberberger/trading-bot/scripts/buildHistoricalReplayBundle.ts)
  - converts externally supplied normalized JSON bars into `HistoricalReplayInput`
- Proxy-backed bundle converter:
  - [scripts/buildProxyHistoricalReplayBundle.ts](/Users/dsilberberger/trading-bot/scripts/buildProxyHistoricalReplayBundle.ts)
  - intended for approximate, non-canonical windows such as `2010–2015`
  - stitches:
    - `VEU -> VXUS` before real `VXUS`
    - synthetic `75% VTV + 25% SHY -> USMV` before real `USMV`
  - writes both:
    - replay bundle JSON
    - proxy metadata JSON marking the bundle as approximate

## External Data Requirement
- Broader validation is still blocked on real normalized bar data.
- Minimum required external file shape:
  - JSON array of rows with:
    - `symbol`
    - `date` in `YYYY-MM-DD`
    - `adjustedClose` or `close`
  - optional:
    - `open`, `high`, `low`, `volume`
- For proxy-backed `2010–2015`, the first supplied dataset should cover:
  - `VTI`, `VTV`, `SHY`, `IEF`, `TIP`
  - `VEU`
  - real `VXUS`
  - real `USMV`
  - plus enough lead-in history before `2010-01-05`

## Recommended Next Step
- Highest-ROI next execution step is broader historical replay validation, starting with `2010–2015`, once external bars are available.
- Validate:
  - baseline `85/15` system with growth off
  - baseline plus `M4` growth
  - against `60/40`, `80/20`, and `100% equity`
