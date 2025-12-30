# Testing Notes

- Run targeted harness tests: `npm test -- --runInBand tests/simPortfolio.test.ts`.
- Assertions mapped to requirements:
  - Cash infusion: weekIndex 4 shows a single `CASH_INFUSION`, higher `coreBudget`, and base buys.
  - Base regime: flat policy test forces a `baseRegimeRisingEdge` to `RISK_ON`, increasing `baseAllowedInvest` (exposure cap bands 35/60/100 with vol dampener) and triggering base orders while keeping core/reserve at 70/30.
  - Reserve ledger: when insurance opens, `reserveUsedInsurance` > 0 and `reserveRemaining` drops; after close/expiry it returns to 0 with `reserveInvariantOk: true`.
  - Insurance timing: `insurance.action === "OPEN"` only when `dislocation.dislocationRisingEdge` is true (`insuranceTriggerReason: "first_dislocation_week_rising_edge"`).
  - Sell protection: with `protectFromSells: true`, base sells still execute while dislocation sells stay blocked.
  - Growth gating: growth opens only in `RISK_ON` with `dislocation.phase === "INACTIVE"` and insurance inactive.

Example weekly output fields (DISLOCATION_RECOVERY):

```json
{
  "scenarioWeekIndex": 3,
  "baseRegime": "RISK_OFF",
  "baseRegimeRisingEdge": false,
  "baseRegimePolicy": { "coreBudgetPct": 0.6, "reserveBudgetPct": 0.4, "baseAllowedInvestPct": 0.3, "policyReason": "drawdown_protection" },
  "dislocation": { "phase": "ADD", "dislocationRisingEdge": true, "protectFromSells": true },
  "insurance": { "action": "OPEN", "insuranceTriggerReason": "first_dislocation_week_rising_edge", "insuranceReserveOnlyOk": true },
  "reserveBudget": 782.39,
  "reserveUsedInsurance": 57,
  "reserveUsedGrowth": 0,
  "reserveRemaining": 725.39,
  "reserveInvariantOk": true
}
```

Inspect a single week manually:

```bash
npx ts-node -e "import { runSimulation } from './scripts/simPortfolio'; runSimulation({}).then(r => console.log(JSON.stringify(r[4], null, 2)));"
```
