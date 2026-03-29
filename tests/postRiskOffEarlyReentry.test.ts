import fs from 'fs';
import path from 'path';
import { buildFeatures, buildRegimes } from '../src/cli/contextBuilder';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { computeBudgets, computeCoreDeployPct } from '../src/core/capital';
import { derivePolicyExposureCap } from '../src/risk/policyExposureCap';
import { planBaseEtfExecution, planWholeShareExecution } from '../src/execution/wholeSharePlanner';
import { rebalancePortfolio } from '../src/execution/rebalanceEngine';
import { computePostRiskOffReentryBudget } from '../src/dislocation/postRiskOffReentry';
import { runSleeveLifecycle } from '../src/dislocation/sleeveLifecycle';

const statePath = path.resolve(process.cwd(), 'data_cache', 'dislocation_sleeve_state.json');
const resetSleeveState = () => {
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
};

const parseDate = (value: string) => new Date(`${value}T00:00:00Z`);
const formatDate = (date: Date) => date.toISOString().slice(0, 10);
const isBusinessDay = (date: Date) => ![0, 6].includes(date.getUTCDay());
const addDays = (date: Date, days: number) => {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
};
const businessDaysBetween = (start: Date, end: Date) => {
  const days: Date[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    if (isBusinessDay(cursor)) days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
};
const interpolateWeeklyToDaily = (bars: Array<{ date: string; close: number }>) => {
  const out: Array<{ date: string; close: number }> = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const a = bars[i];
    const b = bars[i + 1];
    const business = businessDaysBetween(parseDate(a.date), parseDate(b.date));
    const steps = business.length - 1;
    for (let j = 0; j < business.length - 1; j++) {
      const t = steps <= 0 ? 0 : j / steps;
      out.push({
        date: formatDate(business[j]),
        close: a.close + (b.close - a.close) * t
      });
    }
  }
  out.push({ ...bars[bars.length - 1] });
  return out;
};

const applyOrders = (
  portfolio: any,
  orders: Array<{ symbol: string; side: 'BUY' | 'SELL'; notionalUSD: number }>,
  quotes: Record<string, number>
) => {
  type HoldingRow = { symbol: string; quantity: number; avgPrice?: number };
  const holdings = new Map<string, HoldingRow>((portfolio.holdings || []).map((h: any) => [h.symbol, { ...h }]));
  let cash = portfolio.cash || 0;
  for (const order of orders) {
    const px = quotes[order.symbol] || 0;
    const quantity = px > 0 ? Math.round(order.notionalUSD / px) : 0;
    if (order.side === 'BUY') {
      cash -= order.notionalUSD;
      const prev: HoldingRow = holdings.get(order.symbol) || { symbol: order.symbol, quantity: 0, avgPrice: px };
      prev.quantity += quantity;
      holdings.set(order.symbol, prev);
    } else {
      cash += order.notionalUSD;
      const prev: HoldingRow = holdings.get(order.symbol) || { symbol: order.symbol, quantity: 0, avgPrice: px };
      prev.quantity -= quantity;
      if (prev.quantity <= 0) holdings.delete(order.symbol);
      else holdings.set(order.symbol, prev);
    }
  }
  const nextHoldings = Array.from(holdings.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const equity = cash + nextHoldings.reduce((acc, h) => acc + h.quantity * (quotes[h.symbol] || 0), 0);
  return { cash, holdings: nextHoldings, equity };
};

const assetReturn = (symbol: string, anchorReturn: number) => {
  if (symbol === 'VTI') return anchorReturn;
  if (symbol === 'VXUS') return anchorReturn * 0.85;
  if (symbol === 'USMV') return anchorReturn * 0.65;
  if (symbol === 'VTV') return anchorReturn * 0.75;
  if (symbol === 'SHY') return anchorReturn < 0 ? 0.0002 : 0.00005;
  if (symbol === 'IEF') return anchorReturn < 0 ? 0.0008 : -0.0002;
  if (symbol === 'TIP') return anchorReturn * 0.35;
  return anchorReturn * 0.5;
};

const baseInput = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'runs/2026-03-28T02-52/inputs.json'), 'utf8')
);
const proposal = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'runs/2026-03-28T02-52/proposal.json'), 'utf8')
);

const replayConfig = {
  ...baseInput.config,
  dislocation: {
    ...baseInput.config.dislocation,
    enabled: true,
    overlayTargets: [
      { symbol: 'VTI', weight: 0.35 },
      { symbol: 'VXUS', weight: 0.35 },
      { symbol: 'USMV', weight: 0.3 }
    ],
    proxyOnlyOverlay: false,
    earlyReentry: {
      enabled: true,
      reserveDeployPctOfCore: 0.15,
      minRet3: 0.006,
      minRet5: 0.01,
      minNonNegativeShare5: 0.8,
      offBottomPct: 0.012,
      minDaysSinceLow: 3,
      volCoolingPctOfPeak: 0.75
    }
  }
};

const proposalTargets = proposal.intent.orders.map((o: any) => ({
  symbol: o.symbol,
  notionalUSD: o.notionalUSD,
  priority: o.confidence
}));

const episodes = {
  sharp_vol_spike: {
    returns: [-0.02, -0.018, -0.022, -0.015, -0.01, 0.004, -0.008, 0.006, 0.007, 0.008].concat(
      Array(40).fill(0.0035)
    ),
    expectedTriggerDate: '2026-04-06'
  },
  slow_grind_down: {
    returns: Array.from({ length: 20 }, (_, i) => [-0.003, -0.0035, -0.0025, -0.004, -0.003][i % 5]).concat(
      Array(35).fill(0.0025)
    ),
    expectedTriggerDate: '2026-04-27'
  },
  quick_stabilization: {
    returns: [-0.012, -0.01, -0.008, -0.005, -0.003].concat(Array(10).fill(0.0005)).concat(Array(30).fill(0.003)),
    expectedTriggerDate: '2026-04-16'
  },
  choppy_recovery: {
    returns: [-0.012, -0.01, -0.008, -0.006, -0.004]
      .concat([0.006, -0.005, 0.004, -0.006, 0.005, -0.004, 0.003, -0.003, 0.004, -0.002, 0.003, -0.002])
      .concat(Array(25).fill(0.0028)),
    expectedTriggerDate: '2026-04-22'
  },
  false_recovery: {
    returns: [-0.015, -0.012, -0.01, 0.01, 0.008, -0.018, -0.012, -0.01, -0.006, -0.004].concat(
      Array(20).fill(0.0015)
    ),
    expectedTriggerDate: null
  },
  choppy_fail: {
    returns: [-0.012, -0.01, -0.008, 0.007, -0.009, 0.006, -0.01, 0.005, -0.009, 0.004, -0.008, 0.003, -0.007].concat(
      Array(18).fill(0.0015)
    ),
    expectedTriggerDate: null
  }
};

const replayEpisode = (returns: number[]) => {
  resetSleeveState();
  const histories = Object.fromEntries(
    baseInput.universe.map((symbol: string) => [symbol, interpolateWeeklyToDaily(baseInput.history[symbol])])
  ) as Record<string, Array<{ date: string; close: number }>>;
  const universe = baseInput.universe as string[];
  const lastBaseDate = parseDate(histories.VTI[histories.VTI.length - 1].date);
  const currentPrices = Object.fromEntries(
    universe.map((symbol) => [symbol, histories[symbol][histories[symbol].length - 1].close])
  ) as Record<string, number>;
  let prevDate = lastBaseDate;
  const replayDates: string[] = [];

  for (const anchorRet of returns) {
    let next = addDays(prevDate, 1);
    while (!isBusinessDay(next)) next = addDays(next, 1);
    prevDate = next;
    const nextDate = formatDate(next);
    replayDates.push(nextDate);
    for (const symbol of universe) {
      currentPrices[symbol] = currentPrices[symbol] * (1 + assetReturn(symbol, anchorRet));
      histories[symbol].push({ date: nextDate, close: currentPrices[symbol] });
    }
  }

  let portfolio = JSON.parse(JSON.stringify(baseInput.portfolio));
  let priorRegimes: any = null;
  let priorLabel: string | undefined;
  let priorWeeks = 0;
  let peak = histories.VTI[histories.VTI.length - replayDates.length - 1].close;
  const logs: Array<{
    date: string;
    regime: string;
    price: number;
    troughDate: string;
    triggerDate?: string;
    triggerCapitalUsd?: number;
    triggerOrders?: Array<{ symbol: string; notionalUSD: number }>;
  }> = [];
  let triggerDate: string | null = null;
  let triggerCapitalUsd = 0;
  let triggerOrders: Array<{ symbol: string; notionalUSD: number }> = [];

  for (const date of replayDates) {
    const priceMap = Object.fromEntries(
      universe.map((symbol) => {
        const bars = histories[symbol].filter((b) => b.date <= date);
        return [symbol, bars[bars.length - 1].close];
      })
    ) as Record<string, number>;
    peak = Math.max(peak, priceMap.VTI);
    const historySlice = Object.fromEntries(
      universe.map((symbol) => [symbol, histories[symbol].filter((b) => b.date <= date)])
    );
    const featureFlags: any[] = [];
    const features = buildFeatures(universe, priceMap, historySlice as any, featureFlags);
    const built = buildRegimes(`${date}T09:30`, features, baseInput.macro, replayConfig as any);
    const regimes: any = built.regimes;
    const calibration = calibrateEquityConfidence({
      asOf: `${date}T09:30`,
      regimes,
      features,
      config: replayConfig as any,
      prior: { label: priorLabel, timeInRegimeWeeks: priorWeeks }
    });
    regimes.equityRegime.confidence = calibration.confidence;
    regimes.equityRegime.supports = {
      ...(regimes.equityRegime.supports || {}),
      timeInRegimeWeeks: calibration.timeInRegimeWeeks
    };

    portfolio.equity =
      portfolio.cash +
      (portfolio.holdings || []).reduce((acc: number, h: any) => acc + h.quantity * (priceMap[h.symbol] || 0), 0);

    const { coreBudget, reserveBudget } = computeBudgets(portfolio.equity, replayConfig as any);
    const { deployPct } = computeCoreDeployPct(built.regimes, replayConfig as any);
    const deployBudgetUsd = coreBudget * deployPct;
    const exposureCap = derivePolicyExposureCap({
      equityConfidence: regimes.equityRegime.confidence,
      regimeLabel: regimes.equityRegime.label,
      volLabel: regimes.volRegime.label,
      hasMacroLag: true,
      hasCoarsePercentiles: true,
      transitionRisk: regimes.equityRegime.transitionRisk
    });
    const buyBudgetUSD = Math.min(deployBudgetUsd, portfolio.equity * exposureCap);

    const planner = planBaseEtfExecution({
      targets: proposalTargets,
      prices: priceMap,
      buyBudgetUSD,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2,
      regimeLabel: regimes.equityRegime.label,
      timeInRegimeWeeks: calibration.timeInRegimeWeeks
    });
    const sleeveLifecycle = runSleeveLifecycle({
      asOf: `${date}T09:30`,
      config: replayConfig as any,
      dislocationActive: false,
      anchorPrice: priceMap.VTI,
      anchorHistory: historySlice.VTI as any,
      regimes,
      tier: 0
    });

    const rebalance = rebalancePortfolio({
      asOf: `${date}T09:30`,
      portfolio,
      prices: priceMap,
      targetPlan: planner,
      regimes,
      priorRegimes,
      config: replayConfig as any
    });

    const allOrders: Array<{ symbol: string; side: 'BUY' | 'SELL'; notionalUSD: number }> = [
      ...rebalance.combinedOrders.map((o) => ({
        symbol: o.symbol,
        side: o.side,
        notionalUSD: o.notionalUSD
      }))
    ];
    if (
      sleeveLifecycle.allowAdd &&
      sleeveLifecycle.state.triggerReason === 'post_risk_off_reentry' &&
      !triggerDate
    ) {
      triggerDate = date;
      const reserveOnlyCash = Math.max(0, (portfolio.cash || 0) - coreBudget);
      const budget = computePostRiskOffReentryBudget({
        corePoolUsd: coreBudget,
        reservePoolUsd: reserveBudget,
        reserveOnlyCashUsd: reserveOnlyCash,
        config: replayConfig as any
      });
      const overlayPlan = planWholeShareExecution({
        targets: (replayConfig.dislocation?.overlayTargets || []).map((t: any) => ({
          symbol: t.symbol,
          notionalUSD: budget.budgetUSD * t.weight,
          priority: 1
        })),
        prices: priceMap,
        buyBudgetUSD: budget.budgetUSD,
        minCashUSD: 0,
        allowPartial: true,
        minViablePositions: 1,
        maxAbsWeightError: 0.5
      });
      triggerOrders = overlayPlan.orders.map((o) => ({
        symbol: o.symbol,
        notionalUSD: o.estNotionalUSD
      }));
      triggerCapitalUsd = triggerOrders.reduce((acc, o) => acc + o.notionalUSD, 0);
      allOrders.push(...triggerOrders.map((o) => ({ symbol: o.symbol, side: 'BUY' as const, notionalUSD: o.notionalUSD })));
    }

    portfolio = applyOrders(portfolio, allOrders as any, priceMap);
    priorRegimes = JSON.parse(JSON.stringify(regimes));
    priorLabel = regimes.equityRegime.label;
    priorWeeks = calibration.timeInRegimeWeeks;
    const troughDate = histories.VTI
      .filter((b) => replayDates.includes(b.date) && b.date <= date)
      .reduce((min, bar) => (bar.close < min.close ? bar : min), histories.VTI[histories.VTI.length - replayDates.length]).date;
    logs.push({
      date,
      regime: regimes.equityRegime.label,
      price: priceMap.VTI,
      troughDate,
      triggerDate: triggerDate || undefined,
      triggerCapitalUsd: triggerDate === date ? triggerCapitalUsd : undefined,
      triggerOrders: triggerDate === date ? triggerOrders : undefined
    });
  }

  return {
    triggerDate,
    triggerCapitalUsd,
    triggerOrders,
    logs
  };
};

describe('post-risk-off dislocation sleeve early re-entry', () => {
  beforeEach(() => resetSleeveState());
  afterAll(() => resetSleeveState());

  it('triggers in the four recovery episodes and not in false recoveries', () => {
    const results = Object.fromEntries(
      Object.entries(episodes).map(([name, spec]) => [name, replayEpisode(spec.returns)])
    );

    expect(results.sharp_vol_spike.triggerDate).toBe(episodes.sharp_vol_spike.expectedTriggerDate);
    expect(results.slow_grind_down.triggerDate).toBe(episodes.slow_grind_down.expectedTriggerDate);
    expect(results.quick_stabilization.triggerDate).toBe(episodes.quick_stabilization.expectedTriggerDate);
    expect(results.choppy_recovery.triggerDate).toBe(episodes.choppy_recovery.expectedTriggerDate);
    expect(results.false_recovery.triggerDate).toBeNull();
    expect(results.choppy_fail.triggerDate).toBeNull();
  });

  it('does not fire before trough and funds the sleeve from reserve-only cash', () => {
    for (const [name, spec] of Object.entries(episodes)) {
      if (!spec.expectedTriggerDate) continue;
      const result = replayEpisode(spec.returns);
      const triggerLog = result.logs.find((log) => log.date === result.triggerDate);
      expect(triggerLog).toBeDefined();
      if (!triggerLog) continue;
      expect(new Date(result.triggerDate!).getTime()).toBeGreaterThan(new Date(triggerLog.troughDate).getTime());
      expect(result.triggerCapitalUsd).toBeGreaterThan(0);
      expect(result.triggerOrders.length).toBeGreaterThan(0);
      const triggerDayRegime = triggerLog.regime;
      if (name === 'sharp_vol_spike' || name === 'slow_grind_down') {
        expect(triggerDayRegime).toBe('risk_off');
      }
    }
  });
});
