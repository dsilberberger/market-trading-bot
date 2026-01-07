# Project TODO (Snapshot)

Last updated: 2026-01-06

## Reporting & Transparency
- [ ] Report: Add clearer per-symbol rationale for ETF rankings/weights (anchor vs peers), grounded in artifacts.
- [ ] Report: Include confidence quality (full/degraded/blocked) summaries for quick auditing.
- [ ] Report: Ensure regime rationale references anchor fields only (no legacy names).

## Regime & Confidence
- [ ] Volatility: Consider multi-horizon or EWMA volatility for regimes; hysteresis already added (enter >0.7, exit <0.6).
- [ ] Data adequacy: Tighten thresholds per-lookback window and surface “degraded mode” flag in proposals.
- [ ] Benchmarks: Make benchmark symbol explicit in config (avoid SPY fallback where not intended).
- [ ] Growth tilt: Consider a small, regime-gated growth/exposure role (higher beta/tech/quality) with strict caps for better upside participation in strong risk-on regimes.

## Universe & Proxies
- [ ] Clean remaining legacy SPY/QQQ references in docs/tests unless needed for legacy scenarios.
- [ ] Confirm options underlyings align with new universe; keep configurable.

## Harness & Scenarios
- [ ] Refresh harness scenarios to reflect the new universe (VTI/VXUS/VTV/USMV/SHY/IEF/TIP) and updated dislocation overlays.
- [ ] Add a harness case that exercises options sleeve with live-like prices/reserve, verifying reserve ledger.

## Data & Healthchecks
- [ ] Healthcheck: Use new-universe symbols by default; ensure stub/real modes are explicit.
- [ ] Add “degraded data” indicator to proposals when coarse percentiles or inadequate history are present.

## Testing & Safety
- [ ] Expand tests to cover confidence quality propagation into report artifacts.
- [ ] Add regression test for anchor-based regime supports (no hardcoded SPY fields).

## Notes
- Core math, budgets, and regimes should remain unchanged unless explicitly requested.
- Anchor is configurable (currently VTI); proxies separated (execution vs confidence).
- Weekly mapping retained; vol window lengthened and hysteresis applied to stabilize regimes.
- Regime system is deliberately conservative: signals are simple (anchor return/vol/trend + macro rates) and role-based allocation avoids momentum chasing. Good for capital preservation/diversification, but less aggressive in upside capture unless growth tilts are added.
