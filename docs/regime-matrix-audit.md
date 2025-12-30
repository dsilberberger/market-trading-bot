### Regime Matrix Audit

This is an audit/trace only. No trading behavior was changed.

#### End-to-end weekly call chain
- Entrypoint: `src/cli/run.ts` (runBot) → generates base artifacts (features, macro) → computes budgets → builds proposal → applies policy/rebalance.
- Regime computation: `src/cli/contextBuilder.ts` `buildRegimes()` uses SPY features (returns/vol/drawdown/trend), macro series (rates stance/lag), and breadth to produce `RegimeContext` (equityRegime label+confidence+transitionRisk; volRegime label+confidence; ratesRegime label+stance; breadth).
- Policy caps (live run): `src/risk/decisionPolicyGate.ts` `applyDecisionPolicyGate()` maps equity confidence bands (35/60/100) with dampeners (macro lag, coarse percentiles, transitionRisk) to `exposureCap`. Dislocation can add opportunistic exposure; flags capture scaling/blocking.
- Rebalance trigger on regime change: `src/execution/rebalanceEngine.ts` checks `config.rebalance.regimeChangeKeys` (defaults include equityRegime.label/confidence bucket) to force rebalance when regimes shift; uses `RegimeContext` to detect confidence bucket changes.
- Target construction (simulation harness): `scripts/simPortfolio.ts` builds `baseRegime` timeline (deterministic for scenarios) → `getBaseRegimePolicy()` (confidence bands + vol dampener → baseExposureCapPct/policyReason) → `computeDynamicTargetsFromRegimes()` (momentum + regime tilts, fallback to a small default map if no history) → proxy mapping → rebalance decisions/orders via whole-share planner.
- Mapping diagnostics: `scripts/simPortfolio.ts` emits `mappingDiagnostics` (ratioPreserved, unmappedUniversals, sums) alongside `universalTargets` and `proxyTargets`.
- Orders: `scripts/simPortfolio.ts` uses `rebalanceDecisions` to generate BUY/SELL orders (base sleeve) and overlay orders (dislocation sleeve), with sleeve-scoped sells and reserve protection for options.

#### Where the matrix lives and how it’s indexed
- Regime inputs/features: `src/cli/contextBuilder.ts buildRegimes()` — equityConf driven by SPY return60d, vol bucket, trend; volLabel from vol percentile; rates stance from DGS10 trend/level; breadth from feature count. Data quality flags adjust confidence.
- Base regime/policy (sim harness): `scripts/simPortfolio.ts getBaseRegimePolicy()` — inputs: `baseRegimeSnap` {baseRegime, equityConfidence, volLabel}. Output: `baseExposureCapPct`, policyReason (`vol_stressed_dampener` or `confidence_band`).
- Regime → targets (sim harness): `scripts/simPortfolio.ts computeDynamicTargetsFromRegimes()` — scores each symbol on momentum × `regimeTiltForSymbol` and normalizes top `maxPositions`; if no history exists yet, it falls back to the prior small regime-based map.
- Universal → proxy mapping: `scripts/simPortfolio.ts` near mappingDiagnostics — maps universals to proxies (`proxyMap` SPY→SPYM, QQQ→QQQM, TLT→TLT) and normalizes weights; reports sums and unmapped universals.
- Targets to orders: `scripts/simPortfolio.ts` rebalance loop (`rebalanceDecisions`) uses `proxyTargets` and `baseAllowedInvest` to size whole-share buys/sells; overlay path uses `planWholeShareExecution` for dislocation sleeve.

#### Signals that trigger regime changes (live path)
- Equity regime labels: SPY 60d return + above200dma + vol bucket; transitionRisk elevates when vol bucket unknown/high.
- Vol regime: vol percentile bucket.
- Rates: DGS10 trend → rising/falling/stable; stance restrictive if >3.5%.
- Breadth: feature count.
- These are saved to `runs/<runId>/regimes.json` and `llm_context.json`; rebalance keys are configurable in `src/config/default.json` (contains `equityRegime.label` and `equityRegime.confidence`).

#### ETF selection changes when regime changes (sim harness)
- RISK_OFF: heavier TLT, lighter QQQ/SPY; proxy set excludes IWM.
- NEUTRAL: balanced SPY/QQQ/TLT.
- RISK_ON: introduces IWM and raises equity weights; proxyTargets include IWM proxy (direct symbol used).
- Regime transitions are deterministic per scenario in `scripts/simPortfolio.ts buildBaseRegimeTimeline()`.

#### Key inputs/outputs per step
- `buildRegimes` (contextBuilder): inputs `features: SymbolFeature[]`, `macro: MacroSeries[]`, `cfg: BotConfig`; outputs `{ regimes: RegimeContext, flags: DataQualityFlag[] }`.
- `getBaseRegimePolicy` (simPortfolio): input `BaseRegimeSnapshot` { baseRegime, equityConfidence, volLabel }; output `BaseRegimePolicy` { baseExposureCapPct, equityConfidence, volLabel, policyReason }.
- `getUniversalTargetsForRegime` (simPortfolio): input `BaseRegime`; output `Record<string, number>` universal weights.
- Mapping block (simPortfolio): inputs `universalTargets`, `proxyMap`; outputs `proxyTargets`, `mappingDiagnostics`.
- Rebalance loop (simPortfolio): inputs `proxyTargets`, prices, holdings, `baseAllowedInvest`; outputs `rebalanceDecisions`, `orders`.

#### Targets source (helper metadata)
- Added informational field to sim harness output: `targetsSource: { module: 'scripts/simPortfolio', fn: 'getUniversalTargetsForRegime', policyKey: baseRegime }`. This is metadata only and does not affect targets or orders.

#### Potential issues (not fixed here)
- The production run path (src/cli/run.ts) uses decisionPolicyGate caps but does not map regimes to alternative ETF target sets; regime-specific targets only exist in the sim harness. If regime-driven ETF selection is required in production, the mapping would need to be lifted into the live planner.
- BaseRegimeTimeline in the harness is deterministic and not fed by live `RegimeContext`; ensure consistency if you intend to mirror live signals.
