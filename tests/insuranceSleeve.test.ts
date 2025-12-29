import { planInsuranceSleeve, selectInsuranceContract } from '../src/sleeves/insuranceSleeve';
import { arbitrateSleeves } from '../src/sleeves/sleeveArbitration';
import { BotConfig } from '../src/core/types';

const baseConfig: BotConfig = {
  startingCapitalUSD: 250,
  maxPositions: 4,
  rebalanceDay: 'FRIDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.35,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0,
  maxNotionalTradedPctPerRun: 1,
  minHoldHours: 0,
  cadence: 'weekly',
  round0MacroLagPolicy: 'flags_warn',
  macroLagWarnDays: 45,
  macroLagErrorDays: 120,
  minExecutableNotionalUSD: 1,
  fractionalSharesSupported: true,
  allowExecutionProxies: true,
  proxiesFile: 'src/config/proxies.json',
  proxySelectionMode: 'first_executable',
  maxProxyTrackingErrorAbs: 0.1,
  enableExposureGrouping: true,
  exposureGroupsFile: 'src/config/exposure_groups.json',
  canonicalizeExposureGroups: true,
  canonicalizeOnlyInPhase: ['REINTEGRATE'],
  canonicalizeMaxNotionalPctPerRun: 0.1,
  canonicalizeMinDriftToAct: 0.05,
  canonicalizeOnlyIfAffordable: true,
  universeFile: 'src/config/universe.json',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: false,
  requireApproval: true,
  optionsUnderlyings: ['SPY'],
  hedgeProxyPolicy: { hedgePreferred: ['SPY'] },
  insurance: { spendPct: 0.85, minMonths: 3, maxMonths: 6, minMoneyness: 0.95, maxMoneyness: 1.0, limitPriceBufferPct: 0.05, closeWithinDays: 21, allowExpire: false },
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

describe('insurance sleeve activation', () => {
  it('skips when arbitrator disallows', async () => {
    const sleeves = arbitrateSleeves({ dislocationActive: false, regimes: { equityRegime: { label: 'risk_on', confidence: 0.9 } } as any });
    const res = await planInsuranceSleeve({
      runId: 'r1',
      asOf: '2025-01-01',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.insurance,
      reserveBudget: 1000,
      cashAvailable: 1000,
      quotes: { SPY: 100 },
      env: 'test-insurance',
      accountKey: 'case1'
    });
    // disallowed sleeve should never open
    expect(res.plannedAction).not.toBe('OPEN');
  });

  it('opens when allowed and budget sufficient', async () => {
    resetState('test-insurance', 'case2');
    const sleeves = arbitrateSleeves({ dislocationActive: true, regimes: { equityRegime: { label: 'risk_off', confidence: 0.9 } } as any });
    const res = await planInsuranceSleeve({
      runId: 'r2',
      asOf: '2025-01-02',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.insurance,
      reserveBudget: 1000,
      cashAvailable: 1000,
      quotes: { SPY: 100 },
      env: 'test-insurance',
      accountKey: 'case2'
    });
    expect(res.plannedAction).toBe('OPEN');
    expect(res.order).toBeTruthy();
  });

  it('fails gracefully when budget too small for 1 contract', async () => {
    const sleeves = arbitrateSleeves({ dislocationActive: true, regimes: { equityRegime: { label: 'risk_off', confidence: 0.9 } } as any });
    const res = await planInsuranceSleeve({
      runId: 'r3',
      asOf: '2025-01-03',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.insurance,
      reserveBudget: 1,
      cashAvailable: 1,
      quotes: { SPY: 100 },
      env: 'test-insurance',
      accountKey: 'case3'
    });
    expect(res.plannedAction === 'OPEN').toBe(false);
  });
});

describe('contract selection', () => {
  it('returns synthetic contract without chain', async () => {
    const c = await selectInsuranceContract('SPY', '2025-01-01', 100, baseConfig);
    expect(c).toBeTruthy();
    expect(c?.type).toBe('PUT');
  });
});
import fs from 'fs';
import path from 'path';

const resetState = (env: string, account: string) => {
  const fname = ['insurance_state', env, account].join('.') + '.json';
  const p = path.resolve(process.cwd(), 'data_cache', fname);
  if (fs.existsSync(p)) fs.unlinkSync(p);
};
