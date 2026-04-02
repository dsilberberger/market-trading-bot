# Testing Notes

Last updated: 2026-04-01

## Current Baseline To Validate
- Capital lanes: `85/15`
- Exposure cap: smoothed confidence ramp
- Replay execution: sell-path fix promoted into baseline
- Post-plan risk: deterministic position-size scaling promoted into baseline
- Dislocation sleeve: on
- Growth sleeve: off by default
- Optional growth overlay: `M4`
- Insurance: not part of the main validation baseline
- Validation lens:
  - `1x` = constrained implementation case
  - `2x` / `3x` = primary execution-comparable judgment lens

## Core Regression Commands
- Capital partition and replay harness:
```bash
npx jest tests/capitalPartition.test.ts tests/historicalReplayHarness.test.ts --runInBand
```

- Replay sell-path and promoted post-plan risk coverage:
```bash
npx jest tests/replayBroker.test.ts tests/riskEngine.test.ts tests/historicalReplayHarness.test.ts --runInBand
```

- Exposure-cap smoothing coverage:
```bash
npx jest tests/policyExposureCap.test.ts tests/policyExposureAuthority.test.ts tests/historicalReplayHarness.test.ts --runInBand
```

- Growth sleeve coverage:
```bash
npx jest tests/growthSleeve.test.ts tests/historicalReplayHarness.test.ts --runInBand
```

- Scale-aware validation package:
```bash
npm run validation:scale-aware
```

## Recent Sanity Replay References
- `2020–2022` baseline under current `85/15` + smoothed exposure:
  - end equity about `$440.8k`
  - return about `25.96%`
  - max DD about `2.47%`
- `2020–2022` with `M4` growth:
  - end equity about `$458.4k`
  - return about `30.97%`
  - max DD about `2.60%`
- `2016-12-13 -> 2019-12-31` using Nasdaq raw weekly bars, baseline `85/15`:
  - end equity about `$276.15`
  - return about `10.67%`
  - max DD about `7.62%`
- `2016-12-13 -> 2019-12-31` with `M4` overlay:
  - same result as baseline in this window
  - observed reason: no growth sleeve activity
- `2010-01-01 -> 2015-12-31` adjusted replay bundle:
  - artifact exists and is replay-ready
  - classification: approximate / non-canonical
  - observed reason: `VXUS` requires `VEU` pre-history and `USMV` requires a synthetic pre-inception proxy
- Promoted working baseline:
  - config: [src/config/default.json](/Users/dsilberberger/trading-bot/src/config/default.json)
  - legacy diagnostic pre-promotion blocking config: [src/config/default.blocking_post_plan_risk_legacy.json](/Users/dsilberberger/trading-bot/src/config/default.blocking_post_plan_risk_legacy.json)
  - validation package: [research/broad_validation/runs/promoted_working_baseline](/Users/dsilberberger/trading-bot/research/broad_validation/runs/promoted_working_baseline)
  - `2016-12-13 -> 2019-12-31`:
    - return `7.27%`
    - max DD `7.52%`
    - end equity `$267.67`
    - average realized equity allocation `35.97%`
    - blocked buy steps `0`
    - approved buy notional `82.92%` of planned buys
  - `2010-01-01 -> 2015-12-31`:
    - return `11.75%`
    - max DD `6.69%`
    - end equity `$278.88`
    - average realized equity allocation `19.04%`
    - blocked buy steps `14`
    - approved buy notional `98.20%` of planned buys
- Scale-aware validation framework:
  - package: [research/broad_validation/runs/scale_aware_validation](/Users/dsilberberger/trading-bot/research/broad_validation/runs/scale_aware_validation)
  - interpretation:
    - `1x` is no longer the primary strategy-quality lens
    - `2x` / `3x` are the preferred execution-comparable lens
  - `2016-12-13 -> 2019-12-31`:
    - `1x`: return `7.27%`, max DD `7.52%`, avg realized equity `35.97%`, planner-unexecutable `111`
    - `2x`: return `1.93%`, max DD `5.78%`, avg realized equity `27.77%`, planner-unexecutable `15`
    - `3x`: return `-0.40%`, max DD `9.13%`, avg realized equity `28.64%`, planner-unexecutable `0`
  - `2010-01-01 -> 2015-12-31`:
    - `1x`: return `11.75%`, max DD `6.69%`, avg realized equity `29.66%`, planner-unexecutable `39`
    - `2x`: return `-6.84%`, max DD `8.74%`, avg realized equity `22.24%`, planner-unexecutable `0`
    - `3x`: return `-7.64%`, max DD `8.03%`, avg realized equity `19.73%`, planner-unexecutable `0`
  - current interpretation:
    - small-account whole-share geometry was distorting earlier planner conclusions
    - further planner/cap/regime tuning is paused pending broader scale-aware validation

## Historical Replay Bundle Tooling
- Nasdaq external fetcher:
```bash
npx ts-node scripts/fetchNasdaqHistoricalBars.ts --help
```

- Adjusted external fetcher:
```bash
npx ts-node scripts/fetchAdjustedHistoricalBars.ts --help
```

- Adjusted bundle workflow:
```bash
npm run data:build:adjusted -- --window 2010-2015
```

- Real-history converter:
```bash
npx ts-node scripts/buildHistoricalReplayBundle.ts --help
```

- Proxy-backed converter:
```bash
npx ts-node scripts/buildProxyHistoricalReplayBundle.ts --help
```

Current public-source workflow used for the new modern window:
```bash
npx ts-node scripts/fetchNasdaqHistoricalBars.ts \
  --symbols VTI,VXUS,VTV,USMV,SHY,IEF,TIP,VEU \
  --fromdate 2016-01-01 \
  --frequency 1w \
  --weekly-anchor TUESDAY \
  --output research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.json \
  --metadata-output research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.metadata.json

npx ts-node scripts/buildHistoricalReplayBundle.ts \
  --input research/broad_validation/raw_bars/nasdaq_proxy_universe_2016plus_weekly.json \
  --output research/broad_validation/bundles/nasdaq_2016-12-13_2019-12-31_weekly.json \
  --window-start 2016-12-13 \
  --window-end 2019-12-31 \
  --pre-roll-bars 35 \
  --symbols VTI,VXUS,VTV,USMV,SHY,IEF,TIP \
  --calendar-symbol VTI \
  --bar-frequency 1w
```

Current adjusted-data workflow used for the `2010–2015` bundle:
```bash
npm run data:build:adjusted -- --window 2010-2015
```

This writes:
- raw adjusted weekly bars
- raw metadata JSON
- normalized requested-symbol adjusted bars
- normalized metadata JSON
- replay bundle JSON
- replay bundle metadata JSON

Expected external bar format for both:
- JSON array of rows
- required fields:
  - `symbol`
  - `date`
  - `adjustedClose` or `close`
- `date` must be `YYYY-MM-DD`
- `close` is assumed adjusted if `adjustedClose` is absent

## Current Validation Blocker
- Canonical older-window validation is still blocked on exact-symbol adjusted external bar data for `2010–2015`.
- Grounded local replay inputs currently exist only for:
  - `2007–2009`
  - `2020–2022`
- Real external public-source replay input now also exists for:
  - `2016-12-13 -> 2019-12-31`
- Adjusted external public-source replay input now also exists for:
  - `2010-01-01 -> 2015-12-31`
  - classification: approximate / non-canonical

Limitations of the new public-source path:
- source is Nasdaq quote history
- bars are real external OHLC, but not adjusted closes
- observed coverage is modern only, starting `2016-03-31`

Limitations of the new adjusted path:
- source is Yahoo chart history
- adjusted close is available and used for replay bundle construction
- `VXUS` is proxied with rebased `VEU` before `2011-01-24`
- `USMV` is proxied with a synthetic `75% VTV + 25% SHY` return series before `2011-10-17`
