# Proxy & Universe Audit (small config)

Intent: Canonical symbols drive regimes/targets; execution proxies are fallback for affordability/price gaps; confidence proxies are used only by the confidence calibrator when canonical history is short.

Current config (small)
- Universe: VTI, VXUS, VTV, USMV, SHY, IEF, TIP (src/config/universe_small.json)
- Execution proxies (src/config/proxies_small.json):
  - VTI -> ITOT, SCHB
  - VXUS -> IXUS
  - VTV -> SCHV, IWD
  - USMV -> SPLV
  - SHY -> VGSH, SCHO, SHV
  - IEF -> SCHR, VGIT
  - TIP -> SCHP, VTIP
- Confidence proxies (src/config/default.small.json: confidenceCalibration.proxyMap):
  - VTI -> SPY
  - VXUS -> EFA
  - USMV -> SPLV

Key dataflow (code references)
- Features: src/cli/contextBuilder.ts buildFeatures — computes canonical features only; proxies not injected.
- Regimes: src/cli/contextBuilder.ts buildRegimes — uses canonical (anchor) features.
- Confidence: src/strategy/confidenceCalibrator.ts — if canonical history short, may consult confidence proxy map; never used for execution/targets.
- Targets/Execution: src/execution/wholeSharePlanner.ts — takes canonical targets; may substitute execution proxies when prices unavailable or unaffordable; target weights remain canonical.

Verified invariants (tests)
- Confidence suite: tests/confidenceProxyInflation.test.ts, confidenceWiringE2E, confidenceRampDiagnostic, confidenceCalibratorScenarios, proxyMappingStability — all passing.
- Proxy separation: tests/proxySeparation.test.ts — calibrator uses confidence proxy (SPY) not execution proxies.
- Universe wiring: tests/universeSmallConfig.test.ts — asserts universe, exposure metadata, execution proxies.

Determinism & fallback
- If no confidence proxy or insufficient history: calibrator falls back to coverage floor/ramp; dataAdequacy guard blocks run when both canonical and proxy histories are insufficient.
- Execution planner substitutes proxies only as affordability/price fallback; target ratios remain canonical.
