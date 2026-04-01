import fs from 'fs';
import path from 'path';
import { arbitrateSleeves } from '../src/sleeves/sleeveArbitration';
import { planGrowthSleeve, selectGrowthContract } from '../src/sleeves/growthSleeve';
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
  optionsUnderlyings: ['IWM', 'SPY'],
  hedgeProxyPolicy: { growthPreferred: ['IWM', 'SPY'] },
  growth: { spendPct: 0.2, minMonths: 3, maxMonths: 6, minMoneyness: 1.03, maxMoneyness: 1.1, limitPriceBufferPct: 0.05, closeWithinDays: 21, allowExpire: false },
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

const resetState = (env: string, account: string) => {
  const fname = ['growth_state', env, account].join('.') + '.json';
  const p = path.resolve(process.cwd(), 'data_cache', fname);
  if (fs.existsSync(p)) fs.unlinkSync(p);
};

describe('growth sleeve activation', () => {
  it('skips when arbitrator disallows', async () => {
    resetState('test-growth', 'case1');
    const sleeves = arbitrateSleeves({ dislocationActive: true, regimes: { equityRegime: { label: 'risk_on', confidence: 0.9 } } as any });
    const res = await planGrowthSleeve({
      runId: 'g1',
      asOf: '2025-01-01',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.growthConvexity,
      reserveBudget: 1000,
      cashAvailable: 1000,
      quotes: { IWM: 100 },
      env: 'test-growth',
      accountKey: 'case1'
    });
    expect(res.plannedAction).not.toBe('OPEN');
  });

  it('opens when allowed and budget sufficient', async () => {
    resetState('test-growth', 'case2');
    const sleeves = arbitrateSleeves({
      dislocationActive: false,
      regimes: { equityRegime: { label: 'risk_on', confidence: 0.9, supports: { timeInRegimeWeeks: 3 } }, volRegime: { label: 'low' } } as any
    });
    const res = await planGrowthSleeve({
      runId: 'g2',
      asOf: '2025-01-02',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.growthConvexity,
      reserveBudget: 10000,
      reservePoolUsd: 10000,
      cashAvailable: 10000,
      quotes: { IWM: 100 },
      env: 'test-growth',
      accountKey: 'case2'
    });
    expect(res.plannedAction).toBe('OPEN');
    expect(res.order).toBeTruthy();
    expect(res.order?.quantity).toBeGreaterThan(0);
  });

  it('fails gracefully when budget too small', async () => {
    resetState('test-growth', 'case3');
    const sleeves = arbitrateSleeves({ dislocationActive: false, regimes: { equityRegime: { label: 'risk_on', confidence: 0.9 }, volRegime: { label: 'low' } } as any });
    const res = await planGrowthSleeve({
      runId: 'g3',
      asOf: '2025-01-03',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.growthConvexity,
      reserveBudget: 1,
      cashAvailable: 1,
      quotes: { IWM: 100 },
      env: 'test-growth',
      accountKey: 'case3'
    });
    expect(res.plannedAction === 'OPEN').toBe(false);
  });

  it('does not open while insurance is active', async () => {
    resetState('test-growth', 'case4');
    const sleeves = arbitrateSleeves({
      dislocationActive: false,
      regimes: { equityRegime: { label: 'risk_on', confidence: 0.9, supports: { timeInRegimeWeeks: 3 } }, volRegime: { label: 'low' } } as any
    });
    const res = await planGrowthSleeve({
      runId: 'g4',
      asOf: '2025-01-04',
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.growthConvexity,
      reserveBudget: 10000,
      reservePoolUsd: 10000,
      cashAvailable: 10000,
      quotes: { IWM: 100 },
      optionPositions: [
        {
          underlying: 'SPY',
          optionSymbol: 'SPY:PUT:95:2025-04-01',
          type: 'PUT',
          strike: 95,
          expiry: '2025-04-01',
          contracts: 1,
          multiplier: 100,
          avgOpenPrice: 4,
          openDate: '2025-01-01',
          marketPrice: 4,
          marketValueUsd: 400,
          unrealizedPnlUsd: 0
        }
      ],
      env: 'test-growth',
      accountKey: 'case4'
    });
    expect(res.plannedAction).toBe('NONE');
    expect(res.reason).toBe('Growth disabled while insurance is active');
  });
});

describe('growth contract selection', () => {
  it('returns synthetic contract without chain', async () => {
    const c = await selectGrowthContract('IWM', '2025-01-01', 100, baseConfig);
    expect(c).toBeTruthy();
    expect(c?.type).toBe('CALL');
  });
});
