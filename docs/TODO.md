# Project TODO

Last updated: 2026-04-01

## Highest Priority
- [ ] Replace the current approximate adjusted `2010–2015` bundle with a canonical exact-symbol adjusted bundle if a better source becomes available.
- [ ] Expand the new scale-aware validation framework to additional windows:
  - `1x` kept as the constrained implementation case
  - `2x` / `3x` treated as the primary execution-comparable lens
  - replay sell fix kept
  - post-plan risk scaling kept
  - planner variant still excluded
- [ ] Build a compact multi-window scorecard from the promoted working baseline under the scale-aware framework so future comparisons use one clean reference path.

## Broader Validation
- [x] Enable one more regime-diverse real-history window via public external data:
  - provisional `2016-12-13 -> 2019-12-31` using Nasdaq raw weekly bars
- [x] Build the first adjusted replay-ready `2010–2015` bundle:
  - current status: approximate / non-canonical because `VXUS` uses `VEU` pre-history and `USMV` uses a synthetic pre-inception fallback
- [x] Promote the replay sell-path fix into the working baseline.
- [x] Promote the isolated post-plan risk variant into the working validation baseline.
- [x] Formalize scale-aware validation so larger execution-comparable scales (`2x` / `3x`) are the primary strategy-evaluation lens.
- [ ] Decide whether to run the optional `M4` overlay on top of the promoted working baseline, or keep validation focused on the core path until canonical data improves.
- [ ] Decide whether the legacy blocking config should stay permanently for diagnostics or later move into an archived/legacy config area.
- [ ] Decide whether the new Nasdaq-backed `2016-12-13 -> 2019-12-31` run is research-only or should be replaced with adjusted bars and promoted into the formal comparison set.
- [ ] After `2010–2015`, enable at least one more older or adjusted regime-diverse real-history window:
  - `1998–2003`, or
  - canonical adjusted `2016–2019`
- [ ] Decide whether dislocation handoff should stay in the main baseline only after a window shows it actually activates and matters.
- [ ] Expand validation reporting with a compact cross-window comparison view for:
  - return
  - CAGR
  - max drawdown
  - volatility
  - recovery timing
  - dislocation/growth sleeve activity

## Data Tooling
- [x] Add a direct external fetch path for public modern ETF history:
  - `scripts/fetchNasdaqHistoricalBars.ts`
- [x] Add an adjusted external fetch/build path for older validation windows:
  - `scripts/fetchAdjustedHistoricalBars.ts`
  - `scripts/buildAdjustedHistoricalReplayBundle.ts`
- [ ] Add one small example dataset or fixture for the new replay-bundle converter path so the workflow is easier to re-run.
- [ ] Optionally add a lightweight validator/check command for externally supplied historical bar files before replay.
- [ ] Add a second-source fetch path or adapter that can reduce or eliminate the current `VXUS` / `USMV` proxy reliance in `2010–2015`.

## Lower Priority
- [ ] Revisit the planner/account-size seam only after broader scale-aware validation says remaining basket distortions still survive at `2x` / `3x`.
- [ ] Revisit dislocation handoff only if broader validation shows a clear remaining transition gap.
- [ ] Revisit insurance only if broader validation exposes a downside gap that the ETF/dislocation baseline does not handle well enough.
- [ ] Consider later hardening around benchmark/report packaging after cross-window validation is complete.

## Explicitly Deprioritized For Now
- [ ] More option logic beyond the narrow `M4` growth sleeve
- [ ] Insurance as part of the main default architecture
- [ ] Further cap/regime tuning beyond the already shipped exposure smoothing and promoted post-plan risk scaling
- [ ] More planner tuning before broader scale-aware validation is expanded
- [ ] Broad regime-model redesign or new indicator expansion
