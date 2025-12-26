/* eslint-disable no-console */
import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';
import { rebalancePortfolio } from '../src/execution/rebalanceEngine';
import { detectDislocation } from '../src/dislocation/dislocationDetector';
import { runSleeveLifecycle } from '../src/dislocation/sleeveLifecycle';
import { buildDislocationBuys } from '../src/execution/dislocationPlanner';
import { BotConfig, PortfolioState, SleevePositions } from '../src/core/types';

type PricePoint = { date: string; close: number };

const makeHistory = (points: PricePoint[]) => points.map((p) => ({ date: p.date, close: p.close }));

// Basic config tuned for the sim (uses SPYM/QQQM as cheap proxies)
const config: BotConfig = {
  startingCapitalUSD: 2000,
  maxPositions: 4,
  rebalanceDay: 'TUESDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.35,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0.05,
  maxNotionalTradedPctPerRun: 0.5,
  minHoldHours: 0,
  rebalance: {
    enabled: true,
    portfolioDriftThreshold: 0.05,
    positionDriftThreshold: 0.05,
    minTradeNotionalUSD: 25,
    alwaysRebalanceOnRegimeChange: true,
    regimeChangeKeys: ['equityRegime.label'],
    rebalanceDustSharesThreshold: 0
  },
  dislocation: {
    enabled: true,
    anchorSymbol: 'SPY',
    triggerFastDrawdownPct: 0.05,
    triggerSlowDrawdownPct: 0.1,
    durationWeeksAdd: 3,
    durationWeeksHold: 10,
    cooldownWeeks: 2,
    opportunisticExtraExposurePct: 0.15,
    maxTotalExposureCapPct: 0.6,
    sleeveTag: 'dislocation',
    deploymentTargets: [
      { symbol: 'SPYM', weight: 0.7 },
      { symbol: 'QQQM', weight: 0.3 }
    ],
    earlyExit: {
      enabled: true,
      riskOffConfidenceThreshold: 0.7,
      requiresRiskOffLabel: true,
      deepDrawdownFailsafePct: 0.3
    }
  },
  cadence: 'weekly',
  universeFile: '',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: false,
  requireApproval: false,
  uiPort: 8787,
  uiBind: '127.0.0.1',
  allowExecutionProxies: true,
  proxiesFile: '',
  maxProxyTrackingErrorAbs: 0.1
};

interface SimWeek {
  asOf: string;
  spyPrice: number;
  qqqPrice: number;
  tlTPrice: number;
}

const weeks: SimWeek[] = [
  { asOf: '2025-01-07', spyPrice: 100, qqqPrice: 110, tlTPrice: 85 }, // calm
  { asOf: '2025-01-14', spyPrice: 93, qqqPrice: 101, tlTPrice: 86 },  // down a bit
  { asOf: '2025-01-21', spyPrice: 85, qqqPrice: 92, tlTPrice: 87 },   // big drawdown triggers
  { asOf: '2025-01-28', spyPrice: 84, qqqPrice: 90, tlTPrice: 87 },   // add window continues
  { asOf: '2025-02-04', spyPrice: 87, qqqPrice: 93, tlTPrice: 88 },   // hold
  { asOf: '2025-04-08', spyPrice: 98, qqqPrice: 108, tlTPrice: 90 }   // after hold, reintegrate
];

const historyPoints: PricePoint[] = [
  { date: '2024-12-03', close: 100 },
  { date: '2024-12-10', close: 102 },
  { date: '2024-12-17', close: 103 },
  { date: '2024-12-24', close: 104 },
  { date: '2024-12-31', close: 105 }
];

const proxiesMap: Record<string, string[]> = {
  SPY: ['SPYM'],
  QQQ: ['QQQM']
};

const state = {
  portfolio: { cash: 2000, equity: 2000, holdings: [] as PortfolioState['holdings'] },
  sleevePositions: {} as SleevePositions,
  priorRegimes: undefined as any
};

const logWeekHeader = (week: SimWeek, phase: string) => {
  console.log(`\n=== Week ${week.asOf} | SPY ${week.spyPrice} | Dislocation phase: ${phase} ===`);
};

const runWeek = (week: SimWeek) => {
  const quotes: Record<string, number> = {
    SPY: week.spyPrice,
    QQQ: week.qqqPrice,
    TLT: week.tlTPrice,
    SPYM: week.spyPrice * 0.4, // cheap proxies
    QQQM: week.qqqPrice * 0.4
  };

  const history = {
    SPY: makeHistory([...historyPoints, { date: week.asOf, close: week.spyPrice }])
  };

  const dislocation = detectDislocation(week.asOf, config, history as any, quotes);

  const lifecycle = runSleeveLifecycle({
    asOf: week.asOf,
    config,
    dislocationActive: dislocation.active,
    anchorPrice: quotes[config.dislocation?.anchorSymbol || 'SPY'],
    regimes: { equityRegime: { label: dislocation.active ? 'neutral' : 'risk_on', confidence: 0.5 } }
  });

  logWeekHeader(week, lifecycle.state.phase);
  console.log('Dislocation active:', dislocation.active, 'allowAdd:', lifecycle.allowAdd, 'protectFromSells:', lifecycle.protectFromSells);

  // Base target: 35% SPY, 35% QQQ, 30% TLT
  const baseBudget = state.portfolio.cash;
  const baseTargets = [
    { symbol: 'SPY', notionalUSD: baseBudget * 0.35 },
    { symbol: 'QQQ', notionalUSD: baseBudget * 0.35 },
    { symbol: 'TLT', notionalUSD: baseBudget * 0.3 }
  ];

  const planner = planWholeShareExecution({
    targets: baseTargets,
    prices: quotes,
    buyBudgetUSD: baseBudget,
    minCashUSD: 0,
    allowPartial: true,
    minViablePositions: 1,
    maxAbsWeightError: 0.25,
    proxyMap: proxiesMap,
    allowProxies: true,
    maxProxyTrackingErrorAbs: 0.2
  });

  // Rebancing relative to current holdings
  const rebalance = rebalancePortfolio({
    asOf: week.asOf,
    portfolio: state.portfolio,
    prices: quotes,
    targetPlan: planner,
    regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } },
    priorRegimes: state.priorRegimes,
    proxyParentMap: { SPYM: 'SPY', QQQM: 'QQQ' },
    config,
    protectFromSells: lifecycle.protectFromSells,
    protectedSymbols: ['SPYM', 'QQQM'],
    sleevePositions: state.sleevePositions
  });

  let dislocationBuys: any[] = [];
  if (lifecycle.allowAdd && dislocation.active) {
    const extra = config.dislocation?.opportunisticExtraExposurePct || 0;
    const maxTotal = config.dislocation?.maxTotalExposureCapPct || 1;
    const baseCap = 0.35; // assume low confidence cap in sim
    const dislocCap = Math.min(maxTotal, baseCap + extra);
    const extraCap = Math.max(0, dislocCap - baseCap);
    const plan = buildDislocationBuys({
      extraCapPct: extraCap,
      equity: state.portfolio.equity,
      prices: quotes,
      config
    });
    dislocationBuys = plan.orders.map((o) => ({
      symbol: o.symbol,
      side: 'BUY',
      orderType: 'MARKET',
      notionalUSD: o.estNotionalUSD,
      quantity: o.quantity,
      sleeve: 'dislocation'
    }));
  }

  const orders = [...rebalance.combinedOrders, ...dislocationBuys];
  console.log('Orders this week:', orders.map((o) => `${o.side} ${o.symbol} ${o.notionalUSD?.toFixed?.(2) || ''}`));

  // Execute orders in-sim (paper fills)
  for (const o of orders) {
    if (o.side === 'BUY') {
      const qty = (o as any).quantity || Math.floor((o.notionalUSD || 0) / (quotes[o.symbol] || 1));
      const cost = qty * (quotes[o.symbol] || 0);
      state.portfolio.cash -= cost;
      const existing = state.portfolio.holdings.find((h) => h.symbol === o.symbol);
      if (existing) existing.quantity += qty;
      else state.portfolio.holdings.push({ symbol: o.symbol, quantity: qty, avgPrice: quotes[o.symbol] || 0 });
      const sleeve = (o as any).sleeve === 'dislocation' ? 'dislocation' : 'base';
      const sp = state.sleevePositions[o.symbol] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.asOf };
      if (sleeve === 'dislocation') sp.dislocationQty += qty;
      else sp.baseQty += qty;
      sp.updatedAtISO = week.asOf;
      state.sleevePositions[o.symbol] = sp;
    } else if (o.side === 'SELL') {
      const qty = (o as any).quantity || Math.floor((o.notionalUSD || 0) / (quotes[o.symbol] || 1));
      const proceeds = qty * (quotes[o.symbol] || 0);
      state.portfolio.cash += proceeds;
      const existing = state.portfolio.holdings.find((h) => h.symbol === o.symbol);
      if (existing) existing.quantity = Math.max(0, existing.quantity - qty);
      const sp = state.sleevePositions[o.symbol];
      if (sp) {
        const sellBase = Math.min(qty, sp.baseQty);
        sp.baseQty -= sellBase;
        const remaining = qty - sellBase;
        if (remaining > 0) sp.dislocationQty = Math.max(0, sp.dislocationQty - remaining);
        sp.updatedAtISO = week.asOf;
      }
    }
  }

  // Revalue equity
  let equity = state.portfolio.cash;
  for (const h of state.portfolio.holdings) {
    equity += h.quantity * (quotes[h.symbol] || 0);
  }
  state.portfolio.equity = equity;
  state.priorRegimes = { equityRegime: { label: 'neutral', confidence: 0.5 } };

  console.log('Holdings:', state.portfolio.holdings);
  console.log('Sleeves:', state.sleevePositions);
  console.log('Cash:', state.portfolio.cash.toFixed(2), 'Equity:', state.portfolio.equity.toFixed(2));
};

const main = () => {
  for (const w of weeks) runWeek(w);
  console.log('\nSimulation complete.');
};

if (require.main === module) {
  main();
}
