import { rebalancePortfolio } from '../src/execution/rebalanceEngine';
import { ExecutionPlan } from '../src/execution/wholeSharePlanner';

const baseConfig = {
  rebalance: {
    enabled: true,
    portfolioDriftThreshold: 0.05,
    positionDriftThreshold: 0.05,
    minTradeNotionalUSD: 10,
    alwaysRebalanceOnRegimeChange: true,
    regimeChangeKeys: ['equityRegime.label'],
    fullExitRemovedSymbols: true,
    rebalanceDustSharesThreshold: 0
  }
} as any;

describe('rebalancePortfolio', () => {
  const portfolio = {
    cash: 1000,
    equity: 2000,
    holdings: [{ symbol: 'QQQM', quantity: 1, avgPrice: 250 }]
  };
  const prices = { QQQ: 600, QQQM: 250, SPYM: 80 };
  const targetPlan: ExecutionPlan = {
    status: 'OK',
    selectedSymbols: ['QQQM', 'SPYM'],
    orders: [
      { symbol: 'QQQM', side: 'BUY', quantity: 2, estNotionalUSD: 500, estPrice: 250 },
      { symbol: 'SPYM', side: 'BUY', quantity: 2, estNotionalUSD: 160, estPrice: 80 }
    ],
    achievedWeights: {},
    targetWeights: {},
    leftoverCashUSD: 0,
    error: { maxAbsError: 0, l1Error: 0 },
    skipped: [],
    flags: [],
    substitutions: []
  };

  it('skips when drift below thresholds', () => {
    const res = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio: { cash: 1000, equity: 1000, holdings: [] },
      prices: {},
      targetPlan: { ...targetPlan, orders: [] },
      regimes: {},
      priorRegimes: {},
      proxyParentMap: {},
      config: baseConfig
    });
    expect(res.status).toBe('SKIPPED_NO_DRIFT');
  });

  it('generates buys and sells with proxies', () => {
    const res = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio,
      prices,
      targetPlan,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } },
      priorRegimes: { equityRegime: { label: 'neutral', confidence: 0.5 } },
      proxyParentMap: { SPYM: 'SPY', QQQM: 'QQQ' },
      config: baseConfig
    });
    expect(res.status).toBe('OK');
    expect(res.buyOrders.length).toBeGreaterThan(0);
    expect(res.combinedOrders[0].side === 'SELL' || res.combinedOrders[0].side === 'BUY').toBe(true);
  });

  it('caps sells to base sleeve when protection enabled', () => {
    const res = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio: {
        cash: 0,
        equity: 300,
        holdings: [{ symbol: 'SPYM', quantity: 3, avgPrice: 80 }]
      },
      prices: { SPYM: 80 },
      targetPlan: {
        ...targetPlan,
        orders: [{ symbol: 'SPYM', side: 'BUY', quantity: 0, estNotionalUSD: 0, estPrice: 80 }]
      },
      regimes: {},
      priorRegimes: {},
      proxyParentMap: {},
      config: baseConfig,
      protectFromSells: true,
      protectedSymbols: ['SPYM'],
      sleevePositions: { SPYM: { baseQty: 1, dislocationQty: 2, updatedAtISO: '2025-01-01' } }
    });
    expect(res.sellOrders.length).toBe(1);
    expect(res.sellOrders[0].notionalUSD).toBeCloseTo(80);
    expect(res.flags.some((f) => f.code === 'SELL_CAPPED_DUE_TO_SLEEVE_PROTECTION')).toBe(true);
  });

  it('sells full quantity when protection disabled', () => {
    const res = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio: {
        cash: 0,
        equity: 300,
        holdings: [{ symbol: 'SPYM', quantity: 3, avgPrice: 80 }]
      },
      prices: { SPYM: 80 },
      targetPlan: {
        ...targetPlan,
        orders: [{ symbol: 'SPYM', side: 'BUY', quantity: 0, estNotionalUSD: 0, estPrice: 80 }]
      },
      regimes: {},
      priorRegimes: {},
      proxyParentMap: {},
      config: baseConfig,
      protectFromSells: false,
      protectedSymbols: ['SPYM'],
      sleevePositions: { SPYM: { baseQty: 1, dislocationQty: 2, updatedAtISO: '2025-01-01' } }
    });
    expect(res.sellOrders.length).toBe(1);
    expect(res.sellOrders[0].notionalUSD).toBeCloseTo(240);
  });

  it('freezes base sells during add/hold when configured', () => {
    const res = rebalancePortfolio({
      asOf: '2025-01-01',
      portfolio: {
        cash: 0,
        equity: 300,
        holdings: [{ symbol: 'SPYM', quantity: 3, avgPrice: 80 }]
      },
      prices: { SPYM: 80 },
      targetPlan: {
        ...targetPlan,
        orders: [{ symbol: 'SPYM', side: 'BUY', quantity: 0, estNotionalUSD: 0, estPrice: 80 }]
      },
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } },
      priorRegimes: {},
      proxyParentMap: {},
      config: baseConfig,
      protectFromSells: true,
      freezeBaseRebalance: true,
      sleevePositions: { SPYM: { baseQty: 3, dislocationQty: 0, updatedAtISO: '2025-01-01' } }
    });
    expect(res.sellOrders.length).toBe(0);
    expect(res.flags.some((f) => f.code === 'BASE_REBALANCE_FROZEN')).toBe(true);
  });
});
