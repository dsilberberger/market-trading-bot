import { computeBudgets, clampBuyOrdersToBudget } from '../src/core/capital';
import { arbitrateSleeves } from '../src/sleeves/sleeveArbitration';
import { selectOptionsUnderlying } from '../src/sleeves/optionsUnderlying';
import { BotConfig, TradeOrder } from '../src/core/types';

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
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

describe('capital partition', () => {
  it('computes 70/30 budgets', () => {
    const budgets = computeBudgets(1000, { ...baseConfig, capital: { corePct: 0.7, reservePct: 0.3 } });
    expect(budgets.coreBudget).toBeCloseTo(700);
    expect(budgets.reserveBudget).toBeCloseTo(300);
  });

  it('clamps buys to budget', () => {
    const orders: TradeOrder[] = [
      { symbol: 'SPY', side: 'BUY', orderType: 'MARKET', notionalUSD: 600, thesis: '', invalidation: '', confidence: 0.5, portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 } },
      { symbol: 'QQQ', side: 'BUY', orderType: 'MARKET', notionalUSD: 600, thesis: '', invalidation: '', confidence: 0.5, portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 } }
    ];
    const clamped = clampBuyOrdersToBudget(orders, 600);
    const total = clamped.filter((o) => o.side === 'BUY').reduce((acc, o) => acc + o.notionalUSD, 0);
    expect(total).toBeCloseTo(600);
  });
});

describe('sleeve arbitration', () => {
  it('disables growth when dislocation active', () => {
    const res = arbitrateSleeves({ dislocationActive: true, regimes: { equityRegime: { label: 'risk_on', confidence: 0.9 } } as any });
    expect(res.allowed.growthConvexity).toBe(false);
    expect(res.allowed.insurance).toBe(true);
  });

  it('allows growth only when robust and no dislocation', () => {
    const res = arbitrateSleeves({ dislocationActive: false, regimes: { equityRegime: { label: 'risk_on', confidence: 0.9 }, volRegime: { label: 'low' } } as any });
    expect(res.allowed.growthConvexity).toBe(true);
    expect(res.allowed.insurance).toBe(false);
  });
});

describe('options underlying selection', () => {
  it('returns preferred hedge first', () => {
    const cfg: BotConfig = { ...baseConfig, optionsUnderlyings: ['QQQ', 'IWM'], hedgeProxyPolicy: { hedgePreferred: ['QQQ'] } };
    const res = selectOptionsUnderlying('HEDGE', cfg);
    expect(res.symbol).toBe('QQQ');
    expect(res.tried).toEqual(['QQQ']);
  });

  it('falls back when list empty', () => {
    const cfg: BotConfig = { ...baseConfig, optionsUnderlyings: ['SPY'] };
    const res = selectOptionsUnderlying('GROWTH', cfg);
    expect(res.symbol).toBe('SPY');
  });
});
