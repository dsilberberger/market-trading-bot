# Project Status & Context — as of latest changes

## Goals / Philosophy
- Preserve capital in stress; participate in recoveries with guarded upside.
- Enforce 70/30 wall: 70% core (base + dislocation), 30% reserve (options).
- Role-based ETF selection (not “winner picking”): one ETF per role; targets driven by regime weights, not momentum ranks.
- Deterministic, auditable outputs; proxies execution-only; confidence proxies only for calibration.

## Current Config Highlights
- Capital split: core 70%, reserve 30%.
- Base caps: risk_off 0.35; neutral 0.70; risk_on 0.95; fallback 0.50.
- Confidence scaling: threshold 0.50; scaleLow 0.95; ramp 0–1 week.
- Confidence calibration: minHistoryDays 120; coverageFloorConfidence 0.55.
- Universe (canonical): VTI, VXUS, VTV, USMV, SHY, IEF, TIP.
- Execution proxies: VTI→ITOT; VXUS→IXUS; SHY→VGSH/SCHO/SHV; IEF→SCHR/VGIT; TIP→SCHP/VTIP; VTV/USMV optional proxies none.
- Confidence proxies: VTI→ITOT, VXUS→IXUS, USMV→SPLV (calibration only).
- Growth gating (tightened): allow only if risk_on, confidence ≥ 0.6, timeInRegimeWeeks ≥ 2, vol not stressed, no dislocation.
- Planner: whole-share; remainder pass only in risk_on with timeInRegimeWeeks ≥ 1; always bounded by deployBudget and 70/30.
- Options sleeves unchanged; insurance/growth spend only from reserve; reserve ledger isolated from core.

## Recent Behavior Notes
- GFC-style synthetic (bot): start $350k → end ~$319.9k; dominated by risk_off; remainder pass has minimal effect here.
- Aggressive_robo comparison (GFC): end ~$242.9k; much deeper drawdown than bot.
- COVID-style synthetic (bot): start $350k → end ~$224.0k; aggressive_robo end ~$243.9k. Both end below start due to built-in 2022 drawdown; bot more defensive in rebound.
- Steady-bull synthetic is conservative (not a true bull); both bot and robo under-start due to scenario assumptions.

## Key Invariants
- Spend ≤ deployBudget; 70/30 wall enforced.
- Proxies execution-only; confidence proxies do not affect targets.
- Role weights, not momentum ranks; weights ≠ scores.
- ConfidenceQuality = data adequacy; confidence = signal strength (can be low even when quality is full).

## Open Considerations / Next Steps
- If more upside desired in recoveries: evaluate risk_on remainder fill (already on) and possibly adjust confidence penalty or add a small risk_on deploy floor; tread carefully to avoid false positives.
- Historical replay: synthetic scenarios are not real price history; add historical price harness if needed.
- Steady-bull scenario: retune to reflect true uptrend if you want a cleaner bull test.
- Cash utilization: remainder pass only in risk_on to reduce leftover; no redistribution in neutral/risk_off.

## How to Reproduce Key Runs
- GFC synthetic (bot): see `sim-output-gfc.json`; command:
  ```
  npx ts-node --transpile-only -e "const { runSimulation } = require('./scripts/simPortfolio'); const { presetGFC2007to2010 } = require('./scripts/scenario'); runSimulation({ scenario: presetGFC2007to2010, scenarioName: presetGFC2007to2010.name, weeks: 156, startDate: '2007-01-02', startingCapitalUSD: 350000, strategy: 'bot' }).then((r)=>require('fs').writeFileSync('sim-output-gfc.json', JSON.stringify(r,null,2)));"
  ```
- GFC aggressive_robo: same but `strategy: 'aggressive_robo'` → `sim-output-gfc-robo.json`.
- COVID synthetic (bot): `presetCovid2020to2022` → `sim-output-covid.json`; aggressive_robo → `sim-output-covid-robo.json`.
- Live dry-run example: run `src/cli/run.ts` with `--mode live --dry-run --force` (see run `2026-01-06T20-36`).

