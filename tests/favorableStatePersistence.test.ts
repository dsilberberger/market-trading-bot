import { computeFavorableStatePersistence } from '../src/core/capital';
import { rebalancePortfolio } from '../src/execution/rebalanceEngine';
import { ExecutionPlan } from '../src/execution/wholeSharePlanner';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const variantConfig = require('../src/config/default.risk_on_headroom_expansion.persistent_rebalance.position_size_scaled_risk_gate.json');

describe('favorable-state persistence', () => {
  it('leaves weak states unchanged', () => {
    const result = computeFavorableStatePersistence({
      config: variantConfig as any,
      regimeLabel: 'risk_off',
      timeInRegimeWeeks: 4,
      currentEquityAllocationPct: 0.2
    });

    expect(result.active).toBe(false);
    expect(result.maxPersistentOverweightPct).toBe(0);
    expect(result.reason).toBe('not_risk_on');
  });

  it('requires persistent favorable conditions and a low-equity state', () => {
    const tooEarly = computeFavorableStatePersistence({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 1,
      currentEquityAllocationPct: 0.2
    });
    const alreadyRecovered = computeFavorableStatePersistence({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 4,
      currentEquityAllocationPct: 0.45
    });

    expect(tooEarly.active).toBe(false);
    expect(tooEarly.reason).toBe('insufficient_sequence');
    expect(alreadyRecovered.active).toBe(false);
    expect(alreadyRecovered.reason).toBe('not_underinvested');
  });

  it('activates deterministically for underinvested risk_on sequences', () => {
    const week2 = computeFavorableStatePersistence({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 2,
      currentEquityAllocationPct: 0.2
    });
    const repeat = computeFavorableStatePersistence({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 2,
      currentEquityAllocationPct: 0.2
    });

    expect(week2.active).toBe(true);
    expect(week2.maxPersistentOverweightPct).toBeCloseTo(0.08);
    expect(repeat).toEqual(week2);
  });

  it('suppresses small equity trims while preserving new favorable buys', () => {
    const portfolio = {
      cash: 1000,
      equity: 1080,
      holdings: [{ symbol: 'USMV', quantity: 1, avgPrice: 80 }]
    };
    const prices = { USMV: 80, VTI: 100 };
    const targetPlan: ExecutionPlan = {
      status: 'OK',
      selectedSymbols: ['VTI'],
      orders: [{ symbol: 'VTI', side: 'BUY', quantity: 2, estNotionalUSD: 200, estPrice: 100 }],
      achievedWeights: {},
      targetWeights: {},
      leftoverCashUSD: 0,
      error: { maxAbsError: 0, l1Error: 0 },
      skipped: [],
      flags: [],
      substitutions: []
    };

    const baseline = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio,
      prices,
      targetPlan,
      regimes: { equityRegime: { label: 'risk_on', confidence: 0.8 } },
      priorRegimes: { equityRegime: { label: 'risk_on', confidence: 0.8 } },
      proxyParentMap: {},
      config: baseConfig as any,
      favorableStatePersistence: undefined
    });

    const persistent = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio,
      prices,
      targetPlan,
      regimes: { equityRegime: { label: 'risk_on', confidence: 0.8 } },
      priorRegimes: { equityRegime: { label: 'risk_on', confidence: 0.8 } },
      proxyParentMap: {},
      config: variantConfig as any,
      favorableStatePersistence: {
        active: true,
        maxPersistentOverweightPct: 0.08
      },
      exposureGroups: {
        US_MIN_VOL_EQUITY: { members: ['USMV'] as any },
        US_TOTAL_EQUITY: { members: ['VTI'] as any }
      } as any
    });

    expect(baseline.sellOrders.some((order) => order.symbol === 'USMV')).toBe(true);
    expect(persistent.sellOrders.some((order) => order.symbol === 'USMV')).toBe(false);
    expect(persistent.buyOrders.some((order) => order.symbol === 'VTI')).toBe(true);
    expect(persistent.flags.some((flag) => flag.code === 'FAVORABLE_STATE_SELL_SUPPRESSED')).toBe(true);
  });
});
