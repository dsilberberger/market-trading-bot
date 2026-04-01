# Project TODO

Last updated: 2026-03-31

## Highest Priority
- [ ] Supply normalized real historical bars for `2010–2015` so broader validation can start.
- [ ] Build the first real-history or proxy-backed `2010–2015` replay bundle using:
  - `scripts/buildHistoricalReplayBundle.ts`, or
  - `scripts/buildProxyHistoricalReplayBundle.ts`
- [ ] Run the broader validation matrix for `2010–2015`:
  - baseline `85/15`, growth off
  - baseline `85/15` + `M4` growth
  - compare against `60/40`, `80/20`, `100% equity`

## Broader Validation
- [ ] After `2010–2015`, enable at least one more regime-diverse real-history window:
  - `1998–2003`, or
  - `2016–2019`
- [ ] Decide whether dislocation handoff should stay in the main baseline only after a window shows it actually activates and matters.
- [ ] Expand validation reporting with a compact cross-window comparison view for:
  - return
  - CAGR
  - max drawdown
  - volatility
  - recovery timing
  - dislocation/growth sleeve activity

## Data Tooling
- [ ] Add one small example dataset or fixture for the new replay-bundle converter path so the workflow is easier to re-run.
- [ ] Optionally add a lightweight validator/check command for externally supplied historical bar files before replay.

## Lower Priority
- [ ] Revisit dislocation handoff only if broader validation shows a clear remaining transition gap.
- [ ] Revisit insurance only if broader validation exposes a downside gap that the ETF/dislocation baseline does not handle well enough.
- [ ] Consider later hardening around benchmark/report packaging after cross-window validation is complete.

## Explicitly Deprioritized For Now
- [ ] More option logic beyond the narrow `M4` growth sleeve
- [ ] Insurance as part of the main default architecture
- [ ] Further re-entry tuning beyond the already shipped exposure smoothing
- [ ] Broad regime-model redesign or new indicator expansion
