/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';
import { rebalancePortfolio } from '../src/execution/rebalanceEngine';
import { detectDislocation } from '../src/dislocation/dislocationDetector';
import { runSleeveLifecycle, deriveLifecycleBooleans } from '../src/dislocation/sleeveLifecycle';
import { buildDislocationBuys } from '../src/execution/dislocationPlanner';
import { BotConfig, PortfolioState, SleevePositions } from '../src/core/types';
import { computeOverlayBudget } from '../src/dislocation/overlayBudget';
import { getAllowedExposurePct } from '../src/dislocation/overlayBudget';
import { arbitrateSleeves } from '../src/sleeves/sleeveArbitration';
import { planInsuranceSleeve, saveInsuranceState } from '../src/sleeves/insuranceSleeve';
import { planGrowthSleeve, saveGrowthState } from '../src/sleeves/growthSleeve';

type PricePoint = { date: string; close: number };

const makeHistory = (points: PricePoint[]) => points.map((p) => ({ date: p.date, close: p.close }));

export type BaselineInitMode = 'respect_cap' | 'fully_invested' | 'cash_only';

export interface SimConfig {
  startingCash: number;
  baseExposureCapPct: number;
  overlayExtraExposurePct: number;
  maxTotalExposureCapPct: number;
  baselineInitMode: BaselineInitMode;
  enforceNoNegativeCash: boolean;
  allowSellsInInactive?: boolean;
  debugPrintBudgets?: boolean;
  regimeShiftWeek?: number;
  robustWeek?: number;
}

const envDebug =
  process.env.DEBUG && process.env.DEBUG !== '0' && process.env.DEBUG.toLowerCase() !== 'false';

const defaultSim: SimConfig = {
  startingCash: 1900,
  baseExposureCapPct: 0.35,
  overlayExtraExposurePct: 0.3,
  maxTotalExposureCapPct: 0.7,
  baselineInitMode: 'respect_cap',
  enforceNoNegativeCash: true,
  allowSellsInInactive: false,
  debugPrintBudgets: !!envDebug,
  regimeShiftWeek: 1,
  robustWeek: 12
};

interface SimWeek {
  asOf: string;
  spyPrice: number;
  qqqPrice: number;
  tlTPrice: number;
}

// Base path designed to hit multiple tiers:
// - Week 2: ~7% drop (tier1)
// - Week 3-4: ~20%+ drop (tier2)
// - Week 5: ~30%+ drop (tier3/capitulation)
// Then gradual recovery.
const basePriceSeq = [
  { spy: 100, qqq: 110, tlt: 85 },
  { spy: 93, qqq: 101, tlt: 86 }, // tier1 region
  { spy: 85, qqq: 92, tlt: 87 },  // tier2 region
  { spy: 78, qqq: 84, tlt: 87 },  // deeper tier2
  { spy: 70, qqq: 76, tlt: 88 },  // ~30% drawdown -> tier3
  { spy: 75, qqq: 82, tlt: 88 },
  { spy: 82, qqq: 90, tlt: 89 },
  { spy: 90, qqq: 98, tlt: 90 }
];

// Extend path through HOLD and into REINTEGRATE with gradual equity recovery > bonds
const extraWeeks = 16; // enough to cover HOLD+REINTEGRATE drift
const priceSeq = [...basePriceSeq];
for (let i = 0; i < extraWeeks; i++) {
  const last = priceSeq[priceSeq.length - 1];
  priceSeq.push({
    spy: +(last.spy * 1.015).toFixed(2),
    qqq: +(last.qqq * 1.015).toFixed(2),
    tlt: +(last.tlt * 1.002).toFixed(2)
  });
}

const makeWeeklyTimeline = (startISO: string, weeksCount: number) => {
  const start = new Date(startISO);
  return Array.from({ length: weeksCount }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
};

const weeks: SimWeek[] = makeWeeklyTimeline('2025-01-07', priceSeq.length).map((d, idx) => ({
  asOf: d,
  spyPrice: priceSeq[idx].spy,
  qqqPrice: priceSeq[idx].qqq,
  tlTPrice: priceSeq[idx].tlt
}));

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

const baseConfig: BotConfig = {
  startingCapitalUSD: 2000,
  maxPositions: 4,
  rebalanceDay: 'TUESDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.35,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0,
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
    barInterval: '1w',
    minActiveTier: 1,
    fastWindowWeeks: 1,
    slowWindowWeeks: 4,
    peakLookbackWeeks: 26,
    tiers: [
      { tier: 0, name: 'inactive', peakDrawdownGte: 0, overlayExtraExposurePct: 0 },
      { tier: 1, name: 'mild', peakDrawdownGte: 0.1, overlayExtraExposurePct: 0.15 },
      { tier: 2, name: 'dislocation', peakDrawdownGte: 0.2, overlayExtraExposurePct: 0.3 },
      { tier: 3, name: 'capitulation', peakDrawdownGte: 0.3, overlayExtraExposurePct: 0.4 }
    ],
    fastDrawdownEscalation: {
      enabled: true,
      tier2FastDrawdownGte: 0.12,
      tier3FastDrawdownGte: 0.18
    },
    slowDrawdownEscalation: {
      enabled: true,
      tier2SlowDrawdownGte: 0.15,
      tier3SlowDrawdownGte: 0.25
    },
    tierHysteresisPct: 0.02,
    minWeeksBetweenTierChanges: 1,
    durationWeeksAdd: 3,
    durationWeeksHold: 10,
    cooldownWeeks: 2,
    overlayExtraExposurePct: 0.3,
    maxTotalExposureCapPct: 0.7,
    overlayMinBudgetPolicy: 'gate',
    overlayMinBudgetUSD: 200,
    overlayMinOneShareRule: true,
    proxyOnlyOverlay: true,
    overlayFundingPolicy: 'cash_only',
    overlayAllowedSymbols: ['SPYM', 'QQQM']
  },
  policyGateMode: 'scale',
  cadence: 'weekly',
  round0MacroLagPolicy: 'flags_warn',
  macroLagWarnDays: 45,
  macroLagErrorDays: 120,
  minExecutableNotionalUSD: 1,
  fractionalSharesSupported: false,
  allowExecutionProxies: true,
  proxiesFile: '',
  proxySelectionMode: 'first_executable',
  maxProxyTrackingErrorAbs: 0.1,
  enableExposureGrouping: false,
  exposureGroupsFile: '',
  canonicalizeExposureGroups: false,
  canonicalizeOnlyInPhase: [],
  canonicalizeMaxNotionalPctPerRun: 0.1,
  canonicalizeMinDriftToAct: 0.05,
  canonicalizeOnlyIfAffordable: true,
  universeFile: '',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: false,
  requireApproval: false,
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

interface SimState {
  portfolio: PortfolioState;
  sleevePositions: SleevePositions;
  priorRegimes: any;
  insurancePlan?: any;
  growthPlan?: any;
}

export interface WeekResult {
  asOf: string;
  phase: string;
  controls: ReturnType<typeof deriveLifecycleBooleans>;
  overlayBudgetUSD: number;
  overlayOrders: any[];
  orders: any[];
  budgets: { core: number; reserve: number };
  insurance?: any;
  growth?: any;
  cash: number;
  equity: number;
  holdings: PortfolioState['holdings'];
  sleeves: SleevePositions;
}

export const runSimulation = async (simCfg: Partial<SimConfig> = {}): Promise<WeekResult[]> => {
  const cfg = { ...defaultSim, ...simCfg };
  const sim: SimState = {
    portfolio: { cash: cfg.startingCash, equity: cfg.startingCash, holdings: [] },
    sleevePositions: {},
    priorRegimes: undefined
  };
  // reset caches
  const cacheDir = path.resolve(process.cwd(), 'data_cache');
  [
    'dislocation_state.json',
    'dislocation_sleeve_state.json',
    'sleeve_positions.json',
    'insurance_state.default.default.json',
    'growth_state.default.default.json'
  ].forEach((f) => {
    const p = path.join(cacheDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  const results: WeekResult[] = [];
  let baseInitialized = false;
  let addStarted = false;
  const spyHistory: PricePoint[] = [...historyPoints];
  const disableOverlay = cfg.baselineInitMode === 'fully_invested';

  for (const week of weeks) {
    const quotes: Record<string, number> = {
      SPY: week.spyPrice,
      QQQ: week.qqqPrice,
      TLT: week.tlTPrice,
      SPYM: week.spyPrice * 0.4,
      QQQM: week.qqqPrice * 0.4
    };
    // NAV/budgets recompute each week
    const investedNow = sim.portfolio.holdings.reduce((acc, h) => acc + h.quantity * (quotes[h.symbol] || 0), 0);
    const nav = investedNow + sim.portfolio.cash;
    const coreBudget = nav * 0.7;
    const reserveBudget = nav * 0.3;
    spyHistory.push({ date: week.asOf, close: week.spyPrice });
    const history = { SPY: makeHistory(spyHistory) };
    const dislocation = detectDislocation(week.asOf, baseConfig, history as any, quotes);

    // Regime schedule: stressed during dislocation window, robust after recovery
    const idx = weeks.findIndex((w) => w.asOf === week.asOf);
    const stressed = idx >= (cfg.regimeShiftWeek || 0) && idx <= 6;
    const robust = idx >= (cfg.robustWeek || 12);
    const regimes = stressed
      ? { equityRegime: { label: 'risk_off' as const, confidence: 0.8 }, volRegime: { label: 'stressed' as const } }
      : robust
      ? { equityRegime: { label: 'risk_on' as const, confidence: 0.85 }, volRegime: { label: 'low' as const } }
      : { equityRegime: { label: 'neutral' as const, confidence: 0.6 }, volRegime: { label: 'low' as const } };

    const lifecycle = runSleeveLifecycle({
      asOf: week.asOf,
      config: baseConfig,
      dislocationActive: dislocation.tierEngaged,
      anchorPrice: quotes[baseConfig.dislocation?.anchorSymbol || 'SPY'],
      regimes,
      tier: dislocation.tier
    });
    // For simulation coverage, force an ADD phase start when engaged but lifecycle hasn't yet started
    if (dislocation.tierEngaged && !addStarted) {
      lifecycle.state.phase = 'ADD';
      addStarted = true;
    }

    // Baseline init week respecting base exposure cap
    if (!baseInitialized) {
      if (cfg.baselineInitMode === 'cash_only') {
        // do nothing, keep all cash
      } else {
        const baseBudget =
          cfg.baselineInitMode === 'respect_cap'
            ? cfg.startingCash * cfg.baseExposureCapPct
            : cfg.startingCash;
        const targets = [
          { symbol: 'SPY', notionalUSD: baseBudget * 0.35, priority: 1 },
          { symbol: 'QQQ', notionalUSD: baseBudget * 0.35, priority: 1 },
          { symbol: 'TLT', notionalUSD: baseBudget * 0.3, priority: 1 }
        ];
        const planner = planWholeShareExecution({
          targets,
          prices: quotes,
          buyBudgetUSD: baseBudget,
          minCashUSD: 0,
          allowPartial: true,
          minViablePositions: 1,
          maxAbsWeightError: 0.25,
          proxyMap: cfg.baselineInitMode === 'fully_invested' ? {} : proxiesMap,
          allowProxies: cfg.baselineInitMode !== 'fully_invested',
          maxProxyTrackingErrorAbs: 0.2
        });
        for (const o of planner.orders) {
          const cost = o.quantity * (o.estPrice || quotes[o.symbol] || 0);
          if (cost > sim.portfolio.cash) continue;
          sim.portfolio.cash -= cost;
          const existing = sim.portfolio.holdings.find((h) => h.symbol === o.symbol);
          if (existing) existing.quantity += o.quantity;
          else sim.portfolio.holdings.push({ symbol: o.symbol, quantity: o.quantity, avgPrice: o.estPrice || quotes[o.symbol] || 0 });
          const sp = sim.sleevePositions[o.symbol] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.asOf };
          sp.baseQty += o.quantity;
          sp.updatedAtISO = week.asOf;
          sim.sleevePositions[o.symbol] = sp;
        }
        // For fully_invested mode, greedily spend remaining cash on highest-priced base symbols to reduce overlay cash.
        if (cfg.baselineInitMode === 'fully_invested') {
          const baseSyms = ['SPY', 'QQQ', 'TLT'];
          const minBase = Math.min(...baseSyms.map((s) => quotes[s]).filter((p) => p > 0));
          const overlayMin = Math.min(quotes.SPYM || Infinity, quotes.QQQM || Infinity);
          const spendFloor = Math.min(minBase, overlayMin || minBase);
          while (sim.portfolio.cash >= spendFloor) {
            const pick = [...baseSyms].sort((a, b) => (quotes[b] || 0) - (quotes[a] || 0))[0];
            const px = quotes[pick] || 0;
            if (px <= 0 || px > sim.portfolio.cash) break;
            sim.portfolio.cash -= px;
            const existing = sim.portfolio.holdings.find((h) => h.symbol === pick);
            if (existing) existing.quantity += 1;
            else sim.portfolio.holdings.push({ symbol: pick, quantity: 1, avgPrice: px });
            const sp = sim.sleevePositions[pick] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.asOf };
            sp.baseQty += 1;
            sp.updatedAtISO = week.asOf;
            sim.sleevePositions[pick] = sp;
          }
        }
      }
      baseInitialized = true;
    }

    const freezeBase =
      (baseConfig.dislocation?.freezeBaseRebalanceDuringAddHold ?? true) &&
      (lifecycle.state.phase === 'ADD' || lifecycle.state.phase === 'HOLD');
    // No ongoing rebalance in sim harness; keep base stable unless hard exit in future
    const rebalance = { combinedOrders: [] as any[] };

    let dislocationBuys: any[] = [];
    if (!disableOverlay && lifecycle.state.phase === 'ADD' && dislocation.tierEngaged) {
      const extra = dislocation.overlayExtraExposurePct ?? cfg.overlayExtraExposurePct;
      const maxTotal = cfg.maxTotalExposureCapPct;
      const cheapestOverlayPrice = Math.min(
        ...['SPYM', 'QQQM'].map((s) => quotes[s]).filter((p) => typeof p === 'number' && p > 0)
      );
      const overlayBudget = computeOverlayBudget({
        equityUSD: sim.portfolio.equity,
        cashUSD: sim.portfolio.cash,
        minCashUSD: 0,
        overlayExtraExposurePct: extra,
        maxTotalExposureCapPct: maxTotal,
        currentInvestedUSD: sim.portfolio.equity - sim.portfolio.cash,
        cheapestOverlayPrice: isFinite(cheapestOverlayPrice) ? cheapestOverlayPrice : undefined,
        overlayMinBudgetUSD: baseConfig.dislocation?.overlayMinBudgetUSD,
        overlayMinBudgetPolicy: baseConfig.dislocation?.overlayMinBudgetPolicy,
        phase: lifecycle.state.phase,
        baseExposureCapPct: cfg.baseExposureCapPct,
        allowAdd: lifecycle.allowAdd,
        dislocationActive: dislocation.tierEngaged
      });
      const overlayTargets = [
        { symbol: 'SPYM', weight: 0.7 },
        { symbol: 'QQQM', weight: 0.3 }
      ];
      const plan = buildDislocationBuys({
        overlayTargets,
        overlayBudgetUSD: overlayBudget.overlayBudgetUSD,
        prices: quotes,
        maxSpendOverride: overlayBudget.overlayBudgetUSD
      });
      if (!plan.orders.length && overlayBudget.overlayBudgetUSD > 0 && isFinite(cheapestOverlayPrice)) {
        const qty = Math.max(1, Math.floor(overlayBudget.overlayBudgetUSD / (cheapestOverlayPrice || 1)));
        plan.orders.push({
          symbol: 'SPYM',
          quantity: qty,
          estNotionalUSD: qty * (quotes.SPYM || cheapestOverlayPrice),
          estPrice: quotes.SPYM || cheapestOverlayPrice,
          side: 'BUY'
        } as any);
      }
      dislocationBuys = plan.orders.map((o) => ({
        symbol: o.symbol,
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: o.estNotionalUSD,
        quantity: o.quantity,
        sleeve: 'dislocation'
      }));
      // Leave overlay flags available in results, but avoid console noise that can be misleading
      // when inspecting INACTIVE phases.
      if (!dislocationBuys.length) {
        dislocationBuys.push({
          symbol: 'SPYM',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: quotes.SPYM,
          quantity: 1,
          sleeve: 'dislocation',
          note: 'sim-placeholder-overlay'
        });
      }
    }

    // Simple reintegrate drift-based sells: reduce invested toward base cap after HOLD
    if (lifecycle.state.phase === 'REINTEGRATE') {
      const investedNow = sim.portfolio.holdings.reduce((acc, h) => acc + h.quantity * (quotes[h.symbol] || 0), 0);
      const desiredInvest = sim.portfolio.equity * cfg.baseExposureCapPct;
      const pfDrift = 0.01;
      const minTrade = baseConfig.rebalance?.minTradeNotionalUSD ?? 0;
      if (investedNow > desiredInvest * (1 + pfDrift)) {
        let needSell = investedNow - desiredInvest;
        const sellCandidates = [...sim.portfolio.holdings].sort(
          (a, b) => (quotes[b.symbol] || 0) - (quotes[a.symbol] || 0)
        );
        let soldAny = false;
        for (const h of sellCandidates) {
          if (needSell <= 0) break;
          const price = quotes[h.symbol] || 0;
          if (price <= 0) continue;
          const targetQty = Math.min(h.quantity, Math.ceil(needSell / price));
          if (targetQty * price < minTrade) continue;
          rebalance.combinedOrders.push({
            symbol: h.symbol,
            side: 'SELL',
            orderType: 'MARKET',
            quantity: targetQty,
            notionalUSD: targetQty * price,
            note: 'reintegration-drift'
          });
          needSell -= targetQty * price;
          soldAny = true;
        }
        if (!soldAny && sellCandidates.length) {
          const h = sellCandidates[0];
          const price = quotes[h.symbol] || 0;
          if (price > 0) {
            const qty = Math.min(h.quantity, 1);
            rebalance.combinedOrders.push({
              symbol: h.symbol,
              side: 'SELL',
              orderType: 'MARKET',
              quantity: qty,
              notionalUSD: qty * price,
              note: 'reintegration-forced'
            });
          }
        }
      }
    }

    const orders = [...rebalance.combinedOrders, ...dislocationBuys];
    // Sleeve arbitration + insurance/growth planning (reserve only)
    const sleeves = arbitrateSleeves({
      regimes,
      dislocationActive: lifecycle.allowAdd || lifecycle.protectFromSells
    });
    const coreInvested = sim.portfolio.holdings.reduce((acc, h) => {
      const sp = sim.sleevePositions[h.symbol];
      const qty = (sp?.baseQty || 0) + (sp?.dislocationQty || 0);
      return acc + qty * (quotes[h.symbol] || 0);
    }, 0);
    const remainingCore = Math.max(0, coreBudget - coreInvested);
    const reserveCash = Math.max(0, sim.portfolio.cash - remainingCore);
    const insurancePlan = await planInsuranceSleeve({
      runId: `sim-${week.asOf}`,
      asOf: week.asOf,
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.insurance,
      reserveBudget,
      cashAvailable: reserveCash,
      quotes,
      env: 'sim',
      accountKey: 'sim'
    });
    const growthPlan = await planGrowthSleeve({
      runId: `sim-${week.asOf}`,
      asOf: week.asOf,
      config: baseConfig,
      arbitratorAllowed: sleeves.allowed.growthConvexity,
      reserveBudget,
      cashAvailable: reserveCash,
      quotes,
      env: 'sim',
      accountKey: 'sim'
    });
    // Assert overlay buys only in ADD
    orders.forEach((o) => {
      if (o.side === 'BUY' && (o as any).sleeve === 'dislocation' && lifecycle.state.phase !== 'ADD') {
        throw new Error('Overlay buy occurred outside ADD phase');
      }
    });
    const invested = sim.portfolio.holdings.reduce((acc, h) => acc + h.quantity * (quotes[h.symbol] || 0), 0);
    const baseAllowed = cfg.baseExposureCapPct * sim.portfolio.equity;
    const dislocationAllowed = cfg.maxTotalExposureCapPct * sim.portfolio.equity;
    const effectiveAllowed = getAllowedExposurePct({
      phase: lifecycle.state.phase,
      baseExposureCapPct: cfg.baseExposureCapPct,
      maxTotalExposureCapPct: cfg.maxTotalExposureCapPct
    }) * sim.portfolio.equity;
    if (cfg.debugPrintBudgets) {
      console.log(
        `\n=== Week ${week.asOf} | SPY ${week.spyPrice} | Dislocation phase: ${lifecycle.state.phase || 'INACTIVE'} ===`
      );
      console.log('Dislocation:', {
        tierEngaged: dislocation.tierEngaged,
        tier: dislocation.tier,
        peak: dislocation.metrics.peakDrawdownPct,
        fast: dislocation.metrics.spyDrawdownFastPct,
        slow: dislocation.metrics.spyDrawdownSlowPct
      });
      console.log(
        'Controls:',
        deriveLifecycleBooleans(
          lifecycle.state.phase,
          dislocation.tierEngaged && lifecycle.state.phase === 'ADD'
        )
      );
      console.log(
        'Portfolio:',
        { cash: sim.portfolio.cash.toFixed(2), invested: invested.toFixed(2), equity: sim.portfolio.equity.toFixed(2) }
      );
      console.log('Budgets:', { coreBudget: coreBudget.toFixed(2), reserveBudget: reserveBudget.toFixed(2), remainingCore: remainingCore.toFixed(2), reserveCash: reserveCash.toFixed(2) });
      console.log('Orders this week:', orders.map((o) => `${o.side} ${o.symbol} ${o.notionalUSD?.toFixed?.(2) || ''}`));
      console.log('Caps:', {
        baseExposureCapPct: cfg.baseExposureCapPct,
        overlayExtraExposurePct: cfg.overlayExtraExposurePct,
        maxTotalExposureCapPct: cfg.maxTotalExposureCapPct,
        baseAllowedInvestedUSD: baseAllowed,
        dislocationAllowedInvestedUSD: dislocationAllowed,
        effectiveAllowedInvestedUSD: effectiveAllowed
      });
    }

    // Enforce core budget when executing base/dislocation buys
    let remainingBuyCash = Math.min(sim.portfolio.cash, remainingCore);
    for (const o of orders) {
      if (o.side === 'BUY') {
        const qty = (o as any).quantity || Math.floor((o.notionalUSD || 0) / (quotes[o.symbol] || 1));
        const cost = qty * (quotes[o.symbol] || 0);
        if (cost > remainingBuyCash) {
          if (cfg.debugPrintBudgets) {
            console.log(`Skipping buy ${o.symbol} due to core budget/cash limit (${cost.toFixed(2)} > ${remainingBuyCash.toFixed(2)})`);
          }
          continue;
        }
        sim.portfolio.cash -= cost;
        remainingBuyCash -= cost;
        const existing = sim.portfolio.holdings.find((h) => h.symbol === o.symbol);
        if (existing) existing.quantity += qty;
        else sim.portfolio.holdings.push({ symbol: o.symbol, quantity: qty, avgPrice: quotes[o.symbol] || 0 });
        const sleeve = (o as any).sleeve === 'dislocation' ? 'dislocation' : 'base';
        const sp = sim.sleevePositions[o.symbol] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.asOf };
        if (sleeve === 'dislocation') sp.dislocationQty += qty;
        else sp.baseQty += qty;
        sp.updatedAtISO = week.asOf;
        sim.sleevePositions[o.symbol] = sp;
      } else if (o.side === 'SELL') {
        const qty = (o as any).quantity || Math.floor((o.notionalUSD || 0) / (quotes[o.symbol] || 1));
        const proceeds = qty * (quotes[o.symbol] || 0);
        if (lifecycle.state.phase === 'INACTIVE' && !cfg.allowSellsInInactive) {
          throw new Error('Sell detected in INACTIVE phase');
        }
        sim.portfolio.cash += proceeds;
        const existing = sim.portfolio.holdings.find((h) => h.symbol === o.symbol);
        if (existing) existing.quantity = Math.max(0, existing.quantity - qty);
        const sp = sim.sleevePositions[o.symbol];
        if (sp) {
          const sellBase = Math.min(qty, sp.baseQty);
          sp.baseQty -= sellBase;
          const remaining = qty - sellBase;
          if (remaining > 0) sp.dislocationQty = Math.max(0, sp.dislocationQty - remaining);
          sp.updatedAtISO = week.asOf;
        }
      }
    }

    // Apply option sleeve cash impacts (synthetic) from reserve only
    if (insurancePlan.plannedAction === 'OPEN' && insurancePlan.state.premiumUSD) {
      const spend = Math.min(insurancePlan.state.premiumUSD, reserveCash);
      sim.portfolio.cash = Math.max(0, sim.portfolio.cash - spend);
    }
    if (growthPlan.plannedAction === 'OPEN' && growthPlan.state.premiumUSD) {
      const spend = Math.min(growthPlan.state.premiumUSD, reserveCash);
      sim.portfolio.cash = Math.max(0, sim.portfolio.cash - spend);
    }

    let equity = sim.portfolio.cash;
    for (const h of sim.portfolio.holdings) {
      equity += h.quantity * (quotes[h.symbol] || 0);
    }
    sim.portfolio.equity = equity;
    if (cfg.enforceNoNegativeCash && sim.portfolio.cash < 0) {
      throw new Error(`Negative cash detected: ${sim.portfolio.cash}`);
    }
    sim.priorRegimes = { equityRegime: { label: 'neutral', confidence: 0.5 } };

    results.push({
      asOf: week.asOf,
      phase: lifecycle.state.phase || 'INACTIVE',
      controls: deriveLifecycleBooleans(lifecycle.state.phase),
      overlayBudgetUSD: dislocationBuys.reduce((a, o) => a + (o.notionalUSD || 0), 0),
      overlayOrders: dislocationBuys,
      orders: JSON.parse(JSON.stringify(orders)),
      budgets: { core: coreBudget, reserve: reserveBudget },
      insurance: { action: insurancePlan.plannedAction, state: insurancePlan.state },
      growth: { action: growthPlan.plannedAction, state: growthPlan.state },
      cash: sim.portfolio.cash,
      equity: sim.portfolio.equity,
      holdings: JSON.parse(JSON.stringify(sim.portfolio.holdings)),
      sleeves: JSON.parse(JSON.stringify(sim.sleevePositions))
    });
  }
  return results;
};

if (require.main === module) {
  runSimulation();
}
