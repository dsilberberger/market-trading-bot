# Project Status & Context

Last updated: 2026-04-01

## Primary Evaluation Lens
- Working validation baseline behavior is now judged through a scale-aware framework:
  - `1x` = constrained implementation case
  - `2x` / `3x` = primary execution-comparable validation lens
- Current reusable command:
  - `npm run validation:scale-aware`
- Current official scale-aware package:
  - [research/broad_validation/runs/scale_aware_validation](/Users/dsilberberger/trading-bot/research/broad_validation/runs/scale_aware_validation)
- Current tuning posture:
  - keep the replay sell-path correctness fix
  - keep promoted post-plan risk scaling
  - pause more planner tuning
  - pause more cap/regime tuning

## Current Validation Candidate
- Core baseline:
  - `85/15` capital lanes
  - smoothed exposure-cap mapping
  - replay sell-path correctness fix
  - post-plan risk uses deterministic position-size scaling for borderline valid buys
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
- Replay sell execution now correctly honors valid sell intent under slippage:
  - legitimate sells no longer fail due to tiny slippage-preview quantity overshoots
- Planner and replay use the same lane semantics:
  - `coreCapitalUsd`, `coreCashUsd`
  - `optionsReserveCapitalUsd`, `optionsReserveCashUsd`
  - `executedOptionReserveUsageUsd`
- Post-plan risk now uses the promoted working baseline behavior:
  - borderline position-size buy violations are scaled to the position limit instead of being fully blocked
  - clearly unsafe contexts still block normally
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
- Current realized-exposure bottleneck ranking after the replay sell fix:
  - planner/account-size compression
  - post-plan risk blocking/remapping
  - upstream policy/regime conservatism
- Growth sleeve is additive in some recovery windows, but narrow and optional.
- Insurance sleeve is not part of the recommended baseline.
- Current tuning state:
  - promoted into working baseline:
    - replay sell-path fix
    - isolated post-plan risk scaling
  - experimental only:
    - basket-preserving planner variant
  - diagnostic only:
    - conditioned coarse-cap variant
    - recovery-friendly regime-gate variant

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
- New external-data window now exercised locally:
  - `2016-12-13 -> 2019-12-31`
  - source: Nasdaq quote-history API
  - frequency: weekly replay bars built from fetched daily OHLC
  - limitation: real external data, but not adjusted-close data
- Requested next windows:
  - `2010–2015`
  - `1998–2003`
  - canonical `2016–2019` with adjusted bars
- Current blocker:
  - exact-symbol canonical adjusted history for `2010–2015` is still unavailable because `VXUS` and `USMV` need pre-inception fallback
  - `1998–2003` remains blocked by much larger symbol-history gaps

## 2010-01-01 -> 2015-12-31 Adjusted Bundle Status
- New adjusted-data artifacts now exist in:
  - [research/broad_validation/raw_bars/yahoo_adjusted_universe_2009-01-01_2015-12-31_weekly.json](/Users/dsilberberger/trading-bot/research/broad_validation/raw_bars/yahoo_adjusted_universe_2009-01-01_2015-12-31_weekly.json)
  - [research/broad_validation/raw_bars/yahoo_adjusted_universe_2009-01-01_2015-12-31_weekly.metadata.json](/Users/dsilberberger/trading-bot/research/broad_validation/raw_bars/yahoo_adjusted_universe_2009-01-01_2015-12-31_weekly.metadata.json)
  - [research/broad_validation/normalized_bars/yahoo_adjusted_requested_2010-01-01_2015-12-31_weekly.json](/Users/dsilberberger/trading-bot/research/broad_validation/normalized_bars/yahoo_adjusted_requested_2010-01-01_2015-12-31_weekly.json)
  - [research/broad_validation/normalized_bars/yahoo_adjusted_requested_2010-01-01_2015-12-31_weekly.metadata.json](/Users/dsilberberger/trading-bot/research/broad_validation/normalized_bars/yahoo_adjusted_requested_2010-01-01_2015-12-31_weekly.metadata.json)
  - [research/broad_validation/bundles/yahoo_adjusted_2010-01-01_2015-12-31_weekly.json](/Users/dsilberberger/trading-bot/research/broad_validation/bundles/yahoo_adjusted_2010-01-01_2015-12-31_weekly.json)
  - [research/broad_validation/bundles/yahoo_adjusted_2010-01-01_2015-12-31_weekly.metadata.json](/Users/dsilberberger/trading-bot/research/broad_validation/bundles/yahoo_adjusted_2010-01-01_2015-12-31_weekly.metadata.json)
- Current classification:
  - adjusted data: yes
  - canonical: no
  - approximate: yes
- Reason it is not canonical:
  - `VXUS` uses rebased `VEU` history before real `VXUS`
  - `USMV` uses a synthetic `75% VTV + 25% SHY` return proxy before real `USMV`
- What this solves:
  - we now have a deterministic adjusted-price replay bundle for the full `2010–2015` validation window
  - benchmark comparability is improved versus the prior unadjusted public-source path
- What remains unresolved:
  - exact-symbol canonical `2010–2015` history
  - older `1998–2003` adjusted coverage with acceptable proxies or exact symbols

## 2016-12-13 -> 2019-12-31 Provisional Validation
- Bundle and source artifacts now exist in:
  - [research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.json](/Users/dsilberberger/trading-bot/research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.json)
  - [research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.metadata.json](/Users/dsilberberger/trading-bot/research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.metadata.json)
  - [research/broad_validation/bundles/nasdaq_2016-12-13_2019-12-31_weekly.json](/Users/dsilberberger/trading-bot/research/broad_validation/bundles/nasdaq_2016-12-13_2019-12-31_weekly.json)
- Replay configs executed:
  - baseline `85/15`, growth off
  - baseline `85/15` + `M4`
- Result:
  - both configs produced the same outcome because `M4` never activated in this window
  - strategy return about `10.67%`
  - strategy max drawdown about `7.62%`
  - end equity about `$276.15` from about `$249.54`
  - benchmarks outperformed on return:
    - `60/40`: about `25.46%`
    - `80/20`: about `32.33%`
    - `100% equity`: about `30.78%`
- Interpretation:
  - this is useful real-history signal for a modern expansion window
  - it is not yet a canonical cross-window validation result because the source bars are raw closes, not adjusted closes

## Promoted Working Baseline Validation
- Working baseline config is now [src/config/default.json](/Users/dsilberberger/trading-bot/src/config/default.json):
  - includes the replay sell-path correctness fix
  - includes the promoted post-plan risk position-size scaling behavior
- Legacy diagnostic config for the pre-promotion blocking behavior:
  - [src/config/default.blocking_post_plan_risk_legacy.json](/Users/dsilberberger/trading-bot/src/config/default.blocking_post_plan_risk_legacy.json)
- Fresh promoted-baseline results:
  - `2016-12-13 -> 2019-12-31`
    - return: `7.27%`
    - max drawdown: `7.52%`
    - end equity: `$267.67`
    - average realized equity allocation: `35.97%`
    - blocked buy steps: `0`
    - approved buy notional: `82.92%` of planned buys
  - `2010-01-01 -> 2015-12-31`
    - return: `11.75%`
    - max drawdown: `6.69%`
    - end equity: `$278.88`
    - average realized equity allocation: `19.04%`
    - blocked buy steps: `14`
    - approved buy notional: `98.20%` of planned buys
- Fresh promoted-baseline validation artifacts live in:
  - [research/broad_validation/runs/promoted_working_baseline](/Users/dsilberberger/trading-bot/research/broad_validation/runs/promoted_working_baseline)
- Promoted-baseline comparison package lives in:
  - [research/broad_validation/runs/promoted_working_baseline/comparison_summary.json](/Users/dsilberberger/trading-bot/research/broad_validation/runs/promoted_working_baseline/comparison_summary.json)
  - [research/broad_validation/runs/promoted_working_baseline/comparison_summary.csv](/Users/dsilberberger/trading-bot/research/broad_validation/runs/promoted_working_baseline/comparison_summary.csv)
  - [research/broad_validation/runs/promoted_working_baseline/decision_memo.md](/Users/dsilberberger/trading-bot/research/broad_validation/runs/promoted_working_baseline/decision_memo.md)

## Scale-Aware Validation Framework
- Official framework package:
  - [research/broad_validation/runs/scale_aware_validation/comparison_summary.json](/Users/dsilberberger/trading-bot/research/broad_validation/runs/scale_aware_validation/comparison_summary.json)
  - [research/broad_validation/runs/scale_aware_validation/comparison_summary.csv](/Users/dsilberberger/trading-bot/research/broad_validation/runs/scale_aware_validation/comparison_summary.csv)
  - [research/broad_validation/runs/scale_aware_validation/decision_memo.md](/Users/dsilberberger/trading-bot/research/broad_validation/runs/scale_aware_validation/decision_memo.md)
- Interpretation:
  - `1x` is retained as a constrained small-account implementation case
  - `2x` / `3x` are now the main strategy-evaluation lens because they remove much of the whole-share affordability distortion
- Current promoted-baseline results under that framework:
  - `2016-12-13 -> 2019-12-31`
    - `1x`: return `7.27%`, max DD `7.52%`, avg realized equity `35.97%`, planner-unexecutable `111`
    - `2x`: return `1.93%`, max DD `5.78%`, avg realized equity `27.77%`, planner-unexecutable `15`
    - `3x`: return `-0.40%`, max DD `9.13%`, avg realized equity `28.64%`, planner-unexecutable `0`
  - `2010-01-01 -> 2015-12-31`
    - `1x`: return `11.75%`, max DD `6.69%`, avg realized equity `29.66%`, planner-unexecutable `39`
    - `2x`: return `-6.84%`, max DD `8.74%`, avg realized equity `22.24%`, planner-unexecutable `0`
    - `3x`: return `-7.64%`, max DD `8.03%`, avg realized equity `19.73%`, planner-unexecutable `0`
- Main conclusion from the scale-aware package:
  - much of the earlier planner pathology was geometric
  - the promoted baseline still looks directionally conservative under cleaner execution conditions
  - the next evaluation work should expand scale-aware validation, not resume planner/cap/regime tuning

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
- Nasdaq fetcher:
  - [scripts/fetchNasdaqHistoricalBars.ts](/Users/dsilberberger/trading-bot/scripts/fetchNasdaqHistoricalBars.ts)
  - fetches real external ETF OHLC rows from Nasdaq quote history
  - can emit normalized `1d` or weekly-resampled `1w` rows
  - writes metadata explicitly marking the source as unadjusted
- Adjusted-data fetcher:
  - [scripts/fetchAdjustedHistoricalBars.ts](/Users/dsilberberger/trading-bot/scripts/fetchAdjustedHistoricalBars.ts)
  - fetches real external raw close plus adjusted close history from Yahoo chart data
  - writes raw bars and source metadata explicitly
- Adjusted replay-bundle workflow:
  - [scripts/buildAdjustedHistoricalReplayBundle.ts](/Users/dsilberberger/trading-bot/scripts/buildAdjustedHistoricalReplayBundle.ts)
  - fetches or imports adjusted source bars
  - normalizes them into requested replay symbols
  - writes bundle metadata classifying the result as canonical or approximate

## External Data Requirement
- Canonical broader validation is still blocked on exact-symbol adjusted real bar data for older windows.
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
- Current public-source fallbacks now available in-repo:
  - Nasdaq quote history for `VTI`, `VXUS`, `VTV`, `USMV`, `SHY`, `IEF`, `TIP`, `VEU`
  - practical coverage observed locally: `2016-03-31 -> 2026-03-31`
  - limitation: raw closes only
  - Yahoo adjusted chart history for `VTI`, `VXUS`, `VEU`, `VTV`, `USMV`, `SHY`, `IEF`, `TIP`
  - practical adjusted bundle now built locally for `2010-01-01 -> 2015-12-31`
  - limitation: still approximate because of explicit `VXUS` and `USMV` pre-inception fallbacks

## Recommended Next Step
- Highest-ROI next execution step is to obtain adjusted or otherwise canonical bars for `2010–2015` and continue validation from the promoted working baseline.
- Secondary next step:
  - decide whether to treat the new Nasdaq-backed `2016-12-13 -> 2019-12-31` run as provisional research only, or to extend it with a better source and make it part of the formal comparison set
