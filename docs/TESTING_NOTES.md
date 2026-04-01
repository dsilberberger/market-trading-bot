# Testing Notes

Last updated: 2026-03-31

## Current Baseline To Validate
- Capital lanes: `85/15`
- Exposure cap: smoothed confidence ramp
- Dislocation sleeve: on
- Growth sleeve: off by default
- Optional growth overlay: `M4`
- Insurance: not part of the main validation baseline

## Core Regression Commands
- Capital partition and replay harness:
```bash
npx jest tests/capitalPartition.test.ts tests/historicalReplayHarness.test.ts --runInBand
```

- Exposure-cap smoothing coverage:
```bash
npx jest tests/policyExposureCap.test.ts tests/policyExposureAuthority.test.ts tests/historicalReplayHarness.test.ts --runInBand
```

- Growth sleeve coverage:
```bash
npx jest tests/growthSleeve.test.ts tests/historicalReplayHarness.test.ts --runInBand
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

## Historical Replay Bundle Tooling
- Real-history converter:
```bash
npx ts-node scripts/buildHistoricalReplayBundle.ts --help
```

- Proxy-backed converter:
```bash
npx ts-node scripts/buildProxyHistoricalReplayBundle.ts --help
```

Expected external bar format for both:
- JSON array of rows
- required fields:
  - `symbol`
  - `date`
  - `adjustedClose` or `close`
- `date` must be `YYYY-MM-DD`
- `close` is assumed adjusted if `adjustedClose` is absent

## Current Validation Blocker
- Broader historical validation windows are still blocked on missing external normalized bar data.
- Grounded local replay inputs currently exist only for:
  - `2007–2009`
  - `2020–2022`
