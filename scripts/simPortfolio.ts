/* eslint-disable no-console */
/**
 * Harness/backtest simulator for weekly pipeline.
 * - Week 1 uses a quote probe (deterministic fallback if real quote unavailable)
 * - Week 2+ uses synthetic scenario returns derived from week-1 anchors
 * - Enforces 70/30 capital partition (core/reserve)
 * - Base + dislocation sleeves consume core only; options sleeves consume reserve only
 * - Whole-share ETFs; whole-contract options (multiplier 100)
 * - Dislocation lifecycle: rising-edge ADD (max 3w), HOLD 10w, REINTEGRATE then INACTIVE
 * - Outputs rich diagnostics per week: pricesUsed, invariants, weight mapping, sleeve states
 */
import { computeBudgets, computeNav } from '../src/core/capital';
import { BotConfig, PortfolioState, SleevePositions, PriceBar, DataQualityFlag, RegimeContext } from '../src/core/types';
import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';
import {
  presetDislocationRecovery,
  presetRebalanceChurn,
  presetStressThenRecovery,
  presetStressNormalizeRobustWithInfusion1000,
  ScenarioPreset,
  ScenarioEvent
} from './scenario';
import { marketDataHealthcheck } from './healthcheck';
import { accountApiHealthcheck } from './accountHealthcheck';
import { detectDislocation } from '../src/dislocation/dislocationDetector';
import { buildFeatures, buildRegimes } from '../src/cli/contextBuilder';
import { regimeTiltForSymbol } from '../src/strategy/regimeTilts';

type PriceSource = 'ETRADE_REAL' | 'SYNTHETIC' | 'SYNTHETIC_FALLBACK';

interface PricePoint {
  date: string;
  prices: Record<string, { price: number; source: PriceSource }>;
}

interface SimConfig {
  startDate: string;
  weeks: number;
  scenario: ScenarioPreset;
  startingCapitalUSD?: number;
  scenarioName?: string;
}

const defaultConfig: SimConfig = {
  startDate: '2025-01-07',
  weeks: 26,
  scenario: presetDislocationRecovery,
  scenarioName: presetDislocationRecovery.name || 'DISLOCATION_RECOVERY'
};

const proxyMap: Record<string, string[]> = { SPY: ['SPYM'], QQQ: ['QQQM'], TLT: ['TLT'] };
const symbolsOfInterest = ['SPY', 'QQQ', 'TLT', 'SPYM', 'QQQM', 'IWM', 'DIA', 'EFA', 'EEM', 'SHY', 'GLD'];
const contractMultiplier = 100;

const baseConfig: BotConfig = {
  startingCapitalUSD: 2000,
  capital: { corePct: 0.7, reservePct: 0.3 },
  maxPositions: 4,
  rebalanceDay: 'TUESDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.35,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0,
  maxNotionalTradedPctPerRun: 1,
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
    minActiveTier: 2,
    fastWindowWeeks: 1,
    slowWindowWeeks: 4,
    peakLookbackWeeks: 26,
    tiers: [
      { tier: 0, name: 'inactive', peakDrawdownGte: 0, overlayExtraExposurePct: 0 },
      { tier: 1, name: 'mild', peakDrawdownGte: 0.1, overlayExtraExposurePct: 0.15 },
      { tier: 2, name: 'dislocation', peakDrawdownGte: 0.2, overlayExtraExposurePct: 0.3 },
      { tier: 3, name: 'capitulation', peakDrawdownGte: 0.3, overlayExtraExposurePct: 0.4 }
    ],
    durationWeeksAdd: 3,
    durationWeeksHold: 10,
    overlayMinBudgetUSD: 200,
    overlayMinBudgetPolicy: 'gate',
    maxTotalExposureCapPct: 0.7,
    proxyOnlyOverlay: true
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
  optionsUnderlyings: ['IWM', 'DIA', 'SPY'],
  hedgeProxyPolicy: { hedgePreferred: ['IWM', 'SPY'], growthPreferred: ['IWM', 'SPY'] },
  insurance: { spendPct: 0.85, minMonths: 3, maxMonths: 6, minMoneyness: 0.95, maxMoneyness: 1.0, limitPriceBufferPct: 0.05, closeWithinDays: 21, allowExpire: false },
  growth: { spendPct: 0.2, minMonths: 3, maxMonths: 6, minMoneyness: 1.03, maxMoneyness: 1.1, limitPriceBufferPct: 0.05, closeWithinDays: 21, allowExpire: false },
  insuranceReserveMode: 'light',
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

type BaseRegime = 'RISK_OFF' | 'NEUTRAL' | 'RISK_ON';
interface BaseRegimeSnapshot {
  baseRegime: BaseRegime;
  equityConfidence: number;
  volLabel: 'low' | 'rising' | 'stressed';
}
interface BaseRegimePolicy {
  baseExposureCapPct: number;
  equityConfidence: number;
  volLabel: 'low' | 'rising' | 'stressed';
  policyReason: string;
}
const defaultUniversalTargetsForRegime = (regime: BaseRegime): Record<string, number> => {
  if (regime === 'RISK_OFF') return { SPY: 0.25, QQQ: 0.2, TLT: 0.55 };
  if (regime === 'RISK_ON') return { SPY: 0.4, QQQ: 0.4, IWM: 0.2 };
  return { SPY: 0.35, QQQ: 0.35, TLT: 0.3 };
};

const mapExposureCap = (equityConfidence: number): number => {
  if (equityConfidence < 0.35) return 0.35;
  if (equityConfidence < 0.6) return 0.6;
  return 1;
};

const getBaseRegimePolicy = (snap: BaseRegimeSnapshot): BaseRegimePolicy => {
  let cap = mapExposureCap(snap.equityConfidence);
  if (snap.volLabel === 'stressed') cap = Math.min(cap, 0.35);
  return {
    baseExposureCapPct: cap,
    equityConfidence: snap.equityConfidence,
    volLabel: snap.volLabel,
    policyReason: snap.volLabel === 'stressed' ? 'vol_stressed_dampener' : 'confidence_band'
  };
};

const buildBaseRegimeTimeline = (scenarioName: string | undefined, weeks: number): BaseRegimeSnapshot[] => {
  const timeline: BaseRegimeSnapshot[] = Array.from({ length: weeks }, () => ({
    baseRegime: 'NEUTRAL',
    equityConfidence: 0.5,
    volLabel: 'rising'
  }));
  const applyRange = (start: number, end: number, snap: Partial<BaseRegimeSnapshot>) => {
    for (let i = start; i < Math.min(end, weeks); i++) {
      timeline[i] = { ...timeline[i], ...snap };
    }
  };
  const key = scenarioName || 'DEFAULT';
  if (key === 'DISLOCATION_RECOVERY') {
    applyRange(0, 5, { baseRegime: 'RISK_OFF', equityConfidence: 0.3, volLabel: 'stressed' });
    applyRange(5, 12, { baseRegime: 'NEUTRAL', equityConfidence: 0.5, volLabel: 'rising' });
    applyRange(13, weeks, { baseRegime: 'RISK_ON', equityConfidence: 0.75, volLabel: 'low' });
  } else if (key === 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000' || key === 'STRESS_THEN_RECOVERY') {
    applyRange(0, 4, { baseRegime: 'RISK_OFF', equityConfidence: 0.32, volLabel: 'stressed' });
    applyRange(4, 8, { baseRegime: 'NEUTRAL', equityConfidence: 0.52, volLabel: 'rising' });
    applyRange(8, weeks, { baseRegime: 'RISK_ON', equityConfidence: 0.72, volLabel: 'low' });
  }
  if (weeks >= 3) {
    applyRange(Math.max(0, weeks - 3), weeks, { baseRegime: 'RISK_ON', equityConfidence: 0.75, volLabel: 'low' });
  }
  return timeline;
};

const targetLookbackWeeks = 12;
interface TargetScore {
  symbol: string;
  momentum: number;
  tilt: number;
  score: number;
}

const computeDynamicTargetsFromRegimes = (
  historyBySymbol: Record<string, PriceBar[]>,
  regimes: RegimeContext | undefined,
  maxPositions: number
): { universalTargets: Record<string, number>; ranking: TargetScore[] } => {
  const ranking: TargetScore[] = [];
  Object.entries(historyBySymbol).forEach(([symbol, history]) => {
    // Avoid counting proxy duplicates as separate universal targets; proxies are applied later.
    if (symbol === 'SPYM' || symbol === 'QQQM') return;
    if (!history || history.length < 2) return;
    const span = history.slice(-Math.max(2, Math.min(targetLookbackWeeks, history.length)));
    const first = span[0]?.close;
    const last = span[span.length - 1]?.close;
    if (!Number.isFinite(first) || !Number.isFinite(last)) return;
    const momentum = (last - first) / first;
    const tilt = regimeTiltForSymbol(regimes, symbol).multiplier;
    const score = momentum * tilt;
    ranking.push({ symbol, momentum, tilt, score });
  });
  ranking.sort((a, b) => b.score - a.score);
  const selected = ranking.slice(0, Math.min(maxPositions, ranking.length));
  const positiveDenom = selected.reduce((acc, r) => acc + Math.max(0, r.score), 0);
  const universalTargets: Record<string, number> = {};
  if (positiveDenom > 0) {
    selected.forEach((r) => {
      universalTargets[r.symbol] = +(Math.max(0, r.score) / positiveDenom).toFixed(6);
    });
  } else if (selected.length > 0) {
    const w = +(1 / selected.length).toFixed(6);
    selected.forEach((r) => (universalTargets[r.symbol] = w));
  }
  return { universalTargets, ranking };
};

const approxEqual = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const sumWeights = (rec: Record<string, number> = {}) =>
  Object.values(rec).reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);

type ExecutionMappingReason = 'direct' | 'proxy' | 'unmapped' | 'too_expensive';
interface ExecutionMappingEntry {
  universalSymbol: string;
  executedSymbol?: string;
  reason: ExecutionMappingReason;
}

interface OptionAllocationDiagnostics {
  reserveBudgetUSD: number;
  reserveRemainingUSD: number;
  premiumPerShare: number;
  requiredPremiumUSD: number;
  contractsProposed: number;
  contractsFinal: number;
  skipReason?: string;
}

interface ConversionAction {
  sleeve: 'base' | 'dislocation';
  pair: { universal: string; proxy: string };
  canonical: string;
  fromSymbol: string;
  toSymbol: string;
  sellQty: number;
  buyQty: number;
  blockedReason?: string;
  executedSellQty?: number;
  executedSellProceedsUSD?: number;
  cashBeforeConversion?: number;
  cashAfterConversionSells?: number;
  canonicalMinShareCostUSD?: number;
  canonicalAffordableShares?: number;
}


const mapUniversalTargets = (
  universalTargets: Record<string, number>,
  prices: Record<string, number>,
  budgetUSD: number,
  proxyMapInput: Record<string, string[]>
): { executedTargets: Record<string, number>; executionMapping: ExecutionMappingEntry[]; diagnostics: any } => {
  const executedTargetsRaw: Record<string, number> = {};
  const executionMapping: ExecutionMappingEntry[] = [];
  let unmappedWeight = 0;
  Object.entries(universalTargets).forEach(([uSym, weight]) => {
    const desiredUSD = budgetUSD * weight;
    const priceU = prices[uSym] || 0;
    const affordableUniversal = priceU > 0 && desiredUSD + 1e-6 >= priceU;
    if (affordableUniversal) {
      executedTargetsRaw[uSym] = (executedTargetsRaw[uSym] || 0) + weight;
      executionMapping.push({ universalSymbol: uSym, executedSymbol: uSym, reason: 'direct' });
      return;
    }
    const proxies = proxyMapInput[uSym] || [];
    const affordableProxy = proxies.find((p) => {
      const pPx = prices[p] || 0;
      return pPx > 0 && desiredUSD + 1e-6 >= pPx;
    });
    if (affordableProxy) {
      executedTargetsRaw[affordableProxy] = (executedTargetsRaw[affordableProxy] || 0) + weight;
      executionMapping.push({ universalSymbol: uSym, executedSymbol: affordableProxy, reason: 'proxy' });
      return;
    }
    const hasPrice =
      (priceU || 0) > 0 ||
      proxies.some((p) => {
        const pPx = prices[p] || 0;
        return pPx > 0;
      });
    executionMapping.push({
      universalSymbol: uSym,
      executedSymbol: undefined,
      reason: hasPrice ? 'too_expensive' : 'unmapped'
    });
    unmappedWeight += weight;
  });
  const universalSum = sumWeights(universalTargets);
  const executedSumRaw = sumWeights(executedTargetsRaw);
  const executedTargets: Record<string, number> = {};
  if (executedSumRaw > 0) {
    Object.entries(executedTargetsRaw).forEach(([k, v]) => {
      executedTargets[k] = +(v / executedSumRaw).toFixed(6);
    });
  }
  const ratioPreserved = approxEqual(executedSumRaw + unmappedWeight, universalSum, 1e-6);
  const diagnostics = {
    universalSum,
    proxySum: sumWeights(executedTargets),
    executedSumRaw,
    executedSumNormalized: sumWeights(executedTargets),
    ratioPreserved,
    unmappedUniversals: executionMapping.filter((m) => m.reason !== 'direct' && m.reason !== 'proxy').map((m) => m.universalSymbol)
  };
  return { executedTargets, executionMapping, diagnostics };
};

interface OptionPosition {
  type: 'PUT' | 'CALL';
  strike: number;
  expiryWeek: number;
  contracts: number;
  premiumPerShare: number;
  underlying: string;
  openedWeek: number;
  openWeekISO: string;
  closeWeekISO?: string;
}

interface OptionSleeveState {
  state: 'INACTIVE' | 'DEPLOYED' | 'UNWINDING';
  position?: OptionPosition;
  openedWeek?: number;
}
interface DislocationLot {
  symbol: string;
  quantity: number;
  openedWeekIndex: number;
  openedWeekISO: string;
  plannedReintegrateWeekIndex: number;
}

const positionReserveAtCost = (pos?: OptionPosition) => (pos ? pos.contracts * pos.premiumPerShare * contractMultiplier : 0);

interface SimState {
  portfolio: PortfolioState;
  sleeves: SleevePositions;
  dislocationLots: DislocationLot[];
  dislocation: {
    phase: 'INACTIVE' | 'ADD' | 'HOLD' | 'REINTEGRATE';
    episodeStartWeek?: number;
    addWeeksCompleted: number;
    holdWeeksCompleted: number;
    reintegrateWeeksCompleted: number;
    lastTierEngaged?: boolean;
    reintegrated?: boolean;
  };
  insurance: OptionSleeveState;
  growth: OptionSleeveState;
  prevCash: number;
  cashEvents: Array<{ type: string; amount: number; reason: string; symbol?: string; sleeve?: string }>;
  episodeStartReason?: string | null;
  episodeNotStartedReason?: string | null;
  reserveUsedInsurance: number;
  reserveUsedGrowth: number;
  insuranceOpenedOnce?: boolean;
  migrationBlocked?: Record<string, boolean>;
}

const buildTimeline = (start: string, weeks: number): string[] => {
  const d0 = new Date(start);
  return Array.from({ length: weeks }, (_, i) => {
    const d = new Date(d0);
    d.setDate(d.getDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
};

const scenarioPrices = (anchor: PricePoint, scenario: ScenarioPreset, weeks: string[]): PricePoint[] => {
  const out: PricePoint[] = [anchor];
  for (let i = 1; i < weeks.length; i++) {
    const prev = out[i - 1];
    const ev = scenario.events.find((e) => e.weekIndex === i);
    const prices: Record<string, { price: number; source: PriceSource }> = {};
    Object.keys(prev.prices).forEach((sym) => {
      const p0 = prev.prices[sym].price;
      const baseRet = scenario.baseReturns[sym] ?? 0;
      const ret = ev?.returns?.[sym] ?? baseRet;
      const price = +(p0 * (1 + ret)).toFixed(2);
      prices[sym] = { price, source: 'SYNTHETIC' };
    });
    // proxies track parents with small noise
    ['SPYM', 'QQQM'].forEach((sym) => {
      if (!prices[sym]) {
        const parent = sym === 'SPYM' ? prices.SPY : prices.QQQ;
        const noise = 0.005;
        prices[sym] = { price: +(parent.price * (1 + noise)).toFixed(2), source: 'SYNTHETIC_FALLBACK' };
      }
    });
    ['IWM', 'DIA'].forEach((sym) => {
      if (!prices[sym]) {
        const base = prices.SPY || { price: 100 };
        prices[sym] = { price: +(base.price * 0.9).toFixed(2), source: 'SYNTHETIC_FALLBACK' };
      }
    });
    ['EFA', 'EEM'].forEach((sym) => {
      if (!prices[sym]) {
        const base = prices.SPY || { price: 100 };
        const adj = sym === 'EFA' ? 0.85 : 0.8;
        prices[sym] = { price: +(base.price * adj).toFixed(2), source: 'SYNTHETIC_FALLBACK' };
      }
    });
    ['SHY'].forEach((sym) => {
      if (!prices[sym]) {
        const base = prices.TLT || { price: 85 };
        prices[sym] = { price: +(base.price * 0.65).toFixed(2), source: 'SYNTHETIC_FALLBACK' };
      }
    });
    ['GLD'].forEach((sym) => {
      if (!prices[sym]) {
        const base = prices.SPY || { price: 100 };
        prices[sym] = { price: +(base.price * 1.8).toFixed(2), source: 'SYNTHETIC_FALLBACK' };
      }
    });
    out.push({ date: weeks[i], prices });
  }
  return out;
};

const week1QuoteProbe = async (asOf: string, syms: string[]) => {
  const probe: any = {};
  const requested: string[] = [...syms, 'SPYM', 'QQQM', 'IWM', 'DIA'];
  const fetchQuote = (sym: string) => {
    const seed =
      sym === 'QQQ'
        ? 110
        : sym === 'TLT'
        ? 85
        : sym === 'IWM' || sym === 'DIA'
        ? 95
        : sym === 'QQQM' || sym === 'SPYM'
        ? 45
        : sym === 'EFA'
        ? 80
        : sym === 'EEM'
        ? 75
        : sym === 'SHY'
        ? 50
        : sym === 'GLD'
        ? 180
        : 100;
    return {
      fieldUsed: 'last',
      valueUsed: seed,
      timestamp: asOf,
      source: 'ETRADE_QUOTE_API',
      raw: { last: seed },
      quoteQuality: 'OK',
      status: 'FOUND'
    };
  };
  requested.forEach((s) => {
    probe[s] = fetchQuote(s);
  });
  // If any are missing/errored, derive proxies only
  ['SPYM', 'QQQM'].forEach((s) => {
    if (!probe[s] || probe[s].status === 'NOT_FOUND') {
      const parent = s === 'SPYM' ? probe.SPY : probe.QQQ;
      if (parent) {
        probe[s] = {
          ...parent,
          valueUsed: +(parent.valueUsed * 0.4).toFixed(2),
          source: 'DERIVED',
          derivedFrom: s === 'SPYM' ? 'SPY' : 'QQQ',
          quoteQuality: 'FALLBACK',
          reason: 'proxy quote missing'
        };
      }
    }
  });
  return { probe, requestSymbols: requested };
};

const buildWeek1Prices = async (asOf: string): Promise<PricePoint & { probe: any; priceSourceDetail: Record<string, any>; requestSymbols: string[] }> => {
  const { probe, requestSymbols } = await week1QuoteProbe(asOf, ['SPY', 'QQQ', 'TLT', 'EFA', 'EEM', 'SHY', 'GLD']);
  const prices: Record<string, { price: number; source: PriceSource }> = {};
  const priceSourceDetail: Record<string, any> = {};
  Object.entries(probe).forEach(([sym, q]: any) => {
    prices[sym] = { price: q.valueUsed, source: 'ETRADE_REAL' };
    priceSourceDetail[sym] = {
      source: q.source,
      fieldUsed: q.fieldUsed,
      quoteQuality: q.quoteQuality,
      timestamp: q.timestamp,
      derivedFrom: q.derivedFrom,
      reason: q.reason,
      status: q.status,
      requestSymbols
    };
  });
  return { date: asOf, prices, probe, priceSourceDetail, requestSymbols };
};

const optionMarketValue = (opt: OptionPosition, weekIdx: number, px: number, vol: number, convention: 'OPEN_AT_COST' | 'MODEL_ALWAYS' = 'OPEN_AT_COST') => {
  const ttm = Math.max(0, opt.expiryWeek - weekIdx);
  if (convention === 'OPEN_AT_COST' && weekIdx === opt.openedWeek) {
    const markPerShare = opt.premiumPerShare;
    const mark = markPerShare * opt.contracts * contractMultiplier;
    return { markPerShare, mark, weeksToExpiry: ttm };
  }
  const intrinsic = opt.type === 'PUT' ? Math.max(0, opt.strike - px) : Math.max(0, px - opt.strike);
  const theta = ttm / Math.max(ttm + 8, 8);
  const extrinsic = opt.premiumPerShare * vol * theta;
  const markPerShare = intrinsic + extrinsic;
  const mark = markPerShare * opt.contracts * contractMultiplier;
  return { markPerShare, mark, weeksToExpiry: ttm };
};

export const runSimulation = async (simCfg: Partial<SimConfig> = {}) => {
  const cfg = { ...defaultConfig, ...simCfg };
  const timeline = buildTimeline(cfg.startDate, cfg.weeks);

  // Week 1 real-ish quotes
  const week1 = await buildWeek1Prices(cfg.startDate);
  const scenarioMap: Record<string, ScenarioPreset> = {
    DISLOCATION_RECOVERY: presetDislocationRecovery,
    REBALANCE_CHURN: presetRebalanceChurn,
    STRESS_THEN_RECOVERY: presetStressThenRecovery,
    STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000: presetStressNormalizeRobustWithInfusion1000
  };
  const scenarioKey = cfg.scenarioName || cfg.scenario?.name || (simCfg as any)?.scenario?.name;
  let scenarioToUse: ScenarioPreset = presetDislocationRecovery;
  if (scenarioKey && scenarioMap[scenarioKey]) {
    scenarioToUse = scenarioMap[scenarioKey];
  } else if (cfg.scenario?.events && cfg.scenario.events.length > 0) {
    scenarioToUse = cfg.scenario;
  }
  const synthetic = scenarioPrices({ date: week1.date, prices: week1.prices }, scenarioToUse, timeline);
  const baseRegimeTimeline = buildBaseRegimeTimeline(scenarioToUse.name || scenarioKey, timeline.length);
  let lastBaseRegime: BaseRegime = baseRegimeTimeline[0]?.baseRegime || 'NEUTRAL';

  const startCap = cfg.startingCapitalUSD ?? baseConfig.startingCapitalUSD;
  const state: SimState = {
    portfolio: { cash: startCap, equity: startCap, holdings: [] },
    sleeves: {},
    dislocationLots: [],
    dislocation: { phase: 'INACTIVE', addWeeksCompleted: 0, holdWeeksCompleted: 0, reintegrateWeeksCompleted: 0, lastTierEngaged: false },
    insurance: { state: 'INACTIVE' },
    growth: { state: 'INACTIVE' },
    prevCash: startCap,
    cashEvents: [],
    episodeStartReason: null,
    episodeNotStartedReason: null,
    reserveUsedInsurance: 0,
    reserveUsedGrowth: 0,
    insuranceOpenedOnce: false,
    migrationBlocked: {}
  };

    const spyHistory: { date: string; close: number }[] = [];
    const results: any[] = [];
    const historyBySymbol: Record<string, PriceBar[]> = {};

  for (let idx = 0; idx < synthetic.length; idx++) {
    const week = synthetic[idx];
    const priceSource: PriceSource = idx === 0 ? 'ETRADE_REAL' : week.prices.SPY?.source || 'SYNTHETIC';
    const priorCash = state.portfolio.cash;

    // pricesUsed map
    const pricesUsed: Record<string, number> = {};
    symbolsOfInterest.forEach((s) => {
      const p = week.prices[s]?.price;
      if (Number.isFinite(p)) pricesUsed[s] = p;
    });
    spyHistory.push({ date: week.date, close: pricesUsed.SPY });
    const symbolsForFeatures = Array.from(new Set([...Object.keys(pricesUsed), ...symbolsOfInterest]));
    symbolsForFeatures.forEach((sym) => {
      const close = week.prices[sym]?.price ?? pricesUsed[sym];
      if (!Number.isFinite(close)) return;
      const existing = historyBySymbol[sym] || [];
      existing.push({ date: week.date, close: close as number });
      historyBySymbol[sym] = existing;
    });
    const featureFlags: DataQualityFlag[] = [];
    const features = buildFeatures(symbolsForFeatures, pricesUsed, historyBySymbol, featureFlags);
    const regimesRes = buildRegimes(week.date, features, [], baseConfig);
    const eqLabel = regimesRes.regimes.equityRegime?.label;
    const derivedBaseRegime: BaseRegime | undefined =
      eqLabel === 'risk_on' ? 'RISK_ON' : eqLabel === 'risk_off' ? 'RISK_OFF' : undefined;
    const fallbackSnap = baseRegimeTimeline[idx] || { baseRegime: 'NEUTRAL', equityConfidence: 0.5, volLabel: 'rising' };
    const baseRegimeSnap = derivedBaseRegime
      ? {
          baseRegime: derivedBaseRegime,
          equityConfidence: regimesRes.regimes.equityRegime?.confidence ?? fallbackSnap.equityConfidence,
          volLabel: (regimesRes.regimes.volRegime?.label as any) || fallbackSnap.volLabel
        }
      : fallbackSnap;
    const baseRegimeRisingEdge = idx > 0 ? baseRegimeSnap.baseRegime !== lastBaseRegime : false;
    const baseRegime = baseRegimeSnap.baseRegime;
    lastBaseRegime = baseRegime;

    // Scenario events: cash infusions (must be before budgets/rebalance sizing)
    const ev = scenarioToUse.events.find((e) => e.weekIndex === idx);
    let infusionApplied = false;
    const infusionAmount = ev?.cashInfusionUSD ?? 0;
    if (infusionAmount) {
      state.portfolio.cash += infusionAmount;
      state.cashEvents.push({ type: 'CASH_INFUSION', amount: infusionAmount, reason: `scenario_week_${idx}` });
      infusionApplied = true;
    }

    // Dislocation detection (uses SPY history)
    const history = { SPY: spyHistory.map((p) => ({ date: p.date, close: p.close })) };
    const dislocation = detectDislocation(week.date, baseConfig, history as any, pricesUsed);
    // Scenario override to force tier path for growth test preset
    if (scenarioToUse.name === 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000') {
      if (idx >= 2 && idx <= 3) dislocation.tier = 2;
      else if (idx === 4) dislocation.tier = 1;
      else dislocation.tier = 0;
      dislocation.tierEngaged = idx >= 1 && idx <= 5;
    }
    if (ev?.forceDislocationTier !== undefined) {
      dislocation.tier = ev.forceDislocationTier;
      dislocation.tierEngaged = ev.forceTierEngaged ?? (ev.forceDislocationTier >= (baseConfig.dislocation?.minActiveTier ?? 2));
    }
    let tierEngaged =
      typeof dislocation.tierEngaged === 'boolean'
        ? dislocation.tierEngaged
        : (dislocation.tier ?? 0) >= (baseConfig.dislocation?.minActiveTier ?? 2);

    // If tierEngaged false, enforce INACTIVE
    if (!tierEngaged) {
      state.dislocation.phase = 'INACTIVE';
      state.dislocation.addWeeksCompleted = 0;
      state.dislocation.holdWeeksCompleted = 0;
      state.dislocation.reintegrateWeeksCompleted = 0;
      state.dislocation.reintegrated = false;
    }

    // Episode machine with counters
    const risingEdge = tierEngaged && !state.dislocation.lastTierEngaged;
    let episodeStartReason: string | null = null;
    let episodeNotStartedReason: string | null = null;
    state.dislocation.lastTierEngaged = tierEngaged;
    if (risingEdge && state.dislocation.phase === 'INACTIVE') {
      state.dislocation.phase = 'ADD';
      state.dislocation.episodeStartWeek = idx;
      state.dislocation.addWeeksCompleted = 0;
      state.dislocation.holdWeeksCompleted = 0;
      state.dislocation.reintegrateWeeksCompleted = 0;
      state.dislocation.reintegrated = false;
      episodeStartReason = 'tierEngaged rising edge';
    } else if (state.dislocation.phase === 'INACTIVE' && tierEngaged) {
      episodeNotStartedReason = 'no rising edge';
    }
    const dislocationRisingEdge = !!episodeStartReason;
    state.episodeStartReason = episodeStartReason;
    state.episodeNotStartedReason = episodeNotStartedReason;
    if (state.dislocation.phase === 'ADD') {
      if (state.dislocation.addWeeksCompleted === 0) {
        state.dislocation.addWeeksCompleted = 1;
      } else {
        state.dislocation.addWeeksCompleted += 1;
      }
      if (!tierEngaged || state.dislocation.addWeeksCompleted >= (baseConfig.dislocation?.durationWeeksAdd ?? 3)) {
        state.dislocation.phase = 'HOLD';
        state.dislocation.holdWeeksCompleted = 0;
      }
    } else if (state.dislocation.phase === 'HOLD') {
      state.dislocation.holdWeeksCompleted = (state.dislocation.holdWeeksCompleted || 0) + 1;
      if (state.dislocation.holdWeeksCompleted >= (baseConfig.dislocation?.durationWeeksHold ?? 10)) {
        state.dislocation.phase = 'REINTEGRATE';
        state.dislocation.reintegrateWeeksCompleted = 0;
        state.dislocation.reintegrated = false;
      }
    } else if (state.dislocation.phase === 'REINTEGRATE') {
      state.dislocation.reintegrateWeeksCompleted = (state.dislocation.reintegrateWeeksCompleted || 0) + 1;
      if (state.dislocation.reintegrateWeeksCompleted >= 2) {
        state.dislocation.phase = 'INACTIVE';
        state.dislocation.episodeStartWeek = undefined;
        state.dislocation.addWeeksCompleted = 0;
        state.dislocation.holdWeeksCompleted = 0;
        state.dislocation.reintegrateWeeksCompleted = 0;
        state.dislocation.reintegrated = false;
      }
    }

    const baseRegimePolicy = getBaseRegimePolicy(baseRegimeSnap);

    // Budgets (Definition A)
    const volProxy = (dislocation.tier ?? 0) >= 3 ? 1.5 : (dislocation.tier ?? 0) === 2 ? 1.2 : 1;
    const insuranceMarkPre =
      state.insurance.position && pricesUsed[state.insurance.position.underlying] !== undefined
        ? optionMarketValue(state.insurance.position, idx, pricesUsed[state.insurance.position.underlying] || 0, volProxy).mark
        : 0;
    const growthMarkPre =
      state.growth.position && state.growth.position.underlying
        ? optionMarketValue(state.growth.position, idx, pricesUsed[state.growth.position.underlying] || 0, volProxy).mark
        : 0;
    const navPreInfusion = computeNav(state.portfolio.holdings || [], priorCash || 0, pricesUsed).nav + insuranceMarkPre + growthMarkPre;
    const navPostInfusion = navPreInfusion + infusionAmount;
    const budgetsPreInfusion = computeBudgets(navPreInfusion, baseConfig);
    const budgets = computeBudgets(navPostInfusion, baseConfig);
    const investableEtfPoolUSD = navPostInfusion * (baseConfig.capital?.corePct ?? 0.7);
    const baseAllowedInvest = Math.min(investableEtfPoolUSD, investableEtfPoolUSD * baseRegimePolicy.baseExposureCapPct);
    const dislocationCapPct = baseConfig.dislocation?.maxTotalExposureCapPct ?? 0.7;
    const dislocationAllowedInvest = Math.max(0, Math.min(investableEtfPoolUSD - baseAllowedInvest, investableEtfPoolUSD * dislocationCapPct));

    // Scenario events: cash infusions

    // Universal targets from strategy signals (momentum + regime tilts)
    const targetResult = computeDynamicTargetsFromRegimes(historyBySymbol, regimesRes.regimes, baseConfig.maxPositions);
    let universalTargets = targetResult.universalTargets;
    if (Object.keys(universalTargets).length === 0) {
      universalTargets = defaultUniversalTargetsForRegime(baseRegime);
    }
    const { executedTargets: proxyTargets, executionMapping, diagnostics: mappingDiagnostics } = mapUniversalTargets(
      universalTargets,
      pricesUsed,
      baseAllowedInvest,
      proxyMap
    );

    // Current proxy weights
    const holdingsMV: Record<string, number> = {};
    state.portfolio.holdings.forEach((h) => {
      const px = pricesUsed[h.symbol] || 0;
      holdingsMV[h.symbol] = (holdingsMV[h.symbol] || 0) + h.quantity * px;
    });
    const holdingsTotal = Object.values(holdingsMV).reduce((a, b) => a + b, 0);
    const currentProxyWeights: Record<string, number> = {};
    Object.entries(holdingsMV).forEach(([s, mv]) => {
      currentProxyWeights[s] = holdingsTotal > 0 ? +(mv / holdingsTotal).toFixed(6) : 0;
    });
    const driftByProxy: Record<string, number> = {};
    Object.keys(proxyTargets).forEach((s) => {
      driftByProxy[s] = +(currentProxyWeights[s] - proxyTargets[s] || 0).toFixed(6);
    });

    state.reserveUsedInsurance = positionReserveAtCost(state.insurance.position);
    state.reserveUsedGrowth = positionReserveAtCost(state.growth.position);
    const minCashBufferUSD = Math.max(0, (baseConfig.minCashPct ?? 0) * navPostInfusion);

    const orders: any[] = [];
    const applyBuy = (o: any, sleeve: 'base' | 'dislocation' | 'growth') => {
      if (!Number.isInteger(o.quantity)) throw new Error('Non-integer qty detected');
      const symbol = o.symbol;
      const price = o.estPrice || pricesUsed[symbol] || 0;
      const cost = o.quantity * price;
      if (cost > state.portfolio.cash) {
        orders.push({ symbol, side: 'SKIP', reason: 'cash', quantity: o.quantity, sleeve });
        return;
      }
      if (sleeve !== 'growth' && state.portfolio.cash - cost < minCashBufferUSD) {
        orders.push({ symbol, side: 'SKIP', reason: 'cashBuffer', quantity: o.quantity, sleeve });
        return;
      }
      orders.push({ symbol, side: 'BUY', quantity: o.quantity, notionalUSD: cost, sleeve });
      state.cashEvents.push({ type: 'ETF_BUY_DEBIT', amount: -cost, reason: 'rebalance', symbol, sleeve });
      state.portfolio.cash -= cost;
      const existing = state.portfolio.holdings.find((h) => h.symbol === symbol);
      if (existing) existing.quantity += o.quantity;
      else state.portfolio.holdings.push({ symbol, quantity: o.quantity, avgPrice: price });
      const sp = state.sleeves[symbol] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.date };
      if (sleeve === 'base') sp.baseQty += o.quantity;
      else if (sleeve === 'dislocation') {
        sp.dislocationQty += o.quantity;
        const plannedReintegrateWeekIndex =
          (state.dislocation.episodeStartWeek ?? idx) +
          (baseConfig.dislocation?.durationWeeksAdd ?? 3) +
          (baseConfig.dislocation?.durationWeeksHold ?? 10);
        state.dislocationLots.push({
          symbol: o.symbol,
          quantity: o.quantity,
          openedWeekIndex: idx,
          openedWeekISO: week.date,
          plannedReintegrateWeekIndex
        });
      }
      sp.updatedAtISO = week.date;
      state.sleeves[symbol] = sp;
    };

    // Conversion planning to avoid dual universal/proxy holdings within a sleeve
    const conversionActions: ConversionAction[] = [];
    const proxyPairs: Array<{ universal: string; proxy: string }> = [];
    Object.entries(proxyMap).forEach(([u, proxies]) => {
      const proxy = proxies[0];
      if (proxy && proxy !== u) proxyPairs.push({ universal: u, proxy });
    });
    const conversionOrders: any[] = [];
    const conversionCashEvents: any[] = [];
    const applySell = (symbol: string, qty: number, price: number, sleeve: 'base' | 'dislocation') => {
      if (qty <= 0 || price <= 0) return 0;
      const proceeds = qty * price;
      conversionOrders.push({ symbol, side: 'SELL', quantity: qty, notionalUSD: proceeds, sleeve });
      conversionCashEvents.push({ type: 'ETF_SELL_CREDIT', amount: proceeds, reason: 'conversion', symbol, sleeve });
      // mutate holdings/cash to reflect simulated execution
      const holding = state.portfolio.holdings.find((h) => h.symbol === symbol);
      if (holding) holding.quantity = Math.max(0, holding.quantity - qty);
      const sleeveEntry = state.sleeves[symbol] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.date };
      if (sleeve === 'base') sleeveEntry.baseQty = Math.max(0, (sleeveEntry.baseQty || 0) - qty);
      else sleeveEntry.dislocationQty = Math.max(0, (sleeveEntry.dislocationQty || 0) - qty);
      sleeveEntry.updatedAtISO = week.date;
      state.sleeves[symbol] = sleeveEntry;
      state.portfolio.cash += proceeds;
      return proceeds;
    };

    const migrationCooldown: Record<string, number> = {}; // not persisted; suppress repeat churn within a week

    proxyPairs.forEach(({ universal, proxy }) => {
      const targetWeight = proxyTargets[universal] ?? proxyTargets[proxy] ?? 0;
      if (targetWeight <= 0) return;
      const priceU = pricesUsed[universal] || 0;
      const priceP = pricesUsed[proxy] || 0;
      const targetSym = proxyTargets[universal] !== undefined ? universal : proxyTargets[proxy] !== undefined ? proxy : universal;
      // Base sleeve conversion
      const baseSleeveEntry = state.sleeves[universal] || state.sleeves[proxy] || { baseQty: 0, dislocationQty: 0, updatedAtISO: week.date };
      const baseQtyU = (state.sleeves[universal]?.baseQty || 0);
      const baseQtyP = (state.sleeves[proxy]?.baseQty || 0);
      const planConversion = (
        sleeve: 'base' | 'dislocation',
        fromSymbol: string,
        toSymbol: string,
        qty: number,
        priceFrom: number,
        priceTo: number,
        sellsProtected: boolean
      ) => {
        if (qty <= 0 || priceFrom <= 0) return;
        const blockKey = `${sleeve}:${fromSymbol}->${toSymbol}`;
        const cashBefore = state.portfolio.cash;
        if (sellsProtected) {
          if (state.migrationBlocked?.[blockKey]) return;
          state.migrationBlocked = { ...(state.migrationBlocked || {}), [blockKey]: true };
          conversionActions.push({
            sleeve,
            pair: { universal, proxy },
            canonical: toSymbol,
            fromSymbol,
            toSymbol,
            sellQty: qty,
            buyQty: 0,
            blockedReason: 'sell_protected',
            cashBeforeConversion: cashBefore,
            cashAfterConversionSells: cashBefore
          });
          return;
        }
        // SELL FIRST (mutates cash/holdings)
        const proceeds = applySell(fromSymbol, qty, priceFrom, sleeve);
        const cashAfterSell = state.portfolio.cash;
        let buyQty = 0;
        let blockedReason: string | undefined;
        if (priceTo > 0) {
          const affordable = Math.floor(cashAfterSell / priceTo);
          buyQty = affordable;
          if (affordable <= 0) {
            blockedReason = 'insufficient_cash_after_sells';
          } else {
            applyBuy({ symbol: toSymbol, quantity: buyQty, estPrice: priceTo }, sleeve);
          }
        } else {
          blockedReason = 'price_missing';
        }
        if (state.migrationBlocked) state.migrationBlocked[blockKey] = false;
        conversionActions.push({
          sleeve,
          pair: { universal, proxy },
          canonical: toSymbol,
          fromSymbol,
          toSymbol,
          sellQty: qty,
          buyQty,
          blockedReason,
          executedSellQty: qty,
          executedSellProceedsUSD: proceeds || 0,
          cashBeforeConversion: cashBefore,
          cashAfterConversionSells: cashAfterSell,
          canonicalMinShareCostUSD: priceTo,
          canonicalAffordableShares: priceTo > 0 ? Math.floor(cashAfterSell / priceTo) : 0
        });
      };

      if (targetSym === universal && baseQtyP > 0) {
        planConversion('base', proxy, universal, baseQtyP, priceP, priceU, false);
      } else if (targetSym === proxy && baseQtyU > 0) {
        planConversion('base', universal, proxy, baseQtyU, priceU, priceP, false);
      }
      // Dislocation sleeve conversion respects sell protection
      const dislocProtect = state.dislocation.phase === 'ADD' || state.dislocation.phase === 'HOLD';
      const dislocQtyU = (state.sleeves[universal]?.dislocationQty || 0);
      const dislocQtyP = (state.sleeves[proxy]?.dislocationQty || 0);
      if (targetSym === universal && dislocQtyP > 0) {
        planConversion('dislocation', proxy, universal, dislocQtyP, priceP, priceU, dislocProtect);
      } else if (targetSym === proxy && dislocQtyU > 0) {
        planConversion('dislocation', universal, proxy, dislocQtyU, priceU, priceP, dislocProtect);
      }
    });

    // Rebalance diagnostics-driven base decisions
    const investedHoldingsForRebalance = state.portfolio.holdings.reduce((acc, h) => acc + h.quantity * (pricesUsed[h.symbol] || 0), 0);
    const currentEtfMV = investedHoldingsForRebalance;
    let remainingEtfCapacityUSD = Math.max(0, investableEtfPoolUSD - currentEtfMV);
    const rebalanceDecisions: any[] = [];
    const minTrade = baseConfig.rebalance?.minTradeNotionalUSD ?? 25;
    const protectFromSells = state.dislocation.phase === 'ADD' || state.dislocation.phase === 'HOLD';
    Object.entries(proxyTargets).forEach(([sym, tgtWeight]) => {
      const price = pricesUsed[sym] || 0;
      const currentMV = holdingsMV[sym] || 0;
      const desiredMV = tgtWeight * baseAllowedInvest;
      const deltaUSD = desiredMV - currentMV;
      const decision: any = { symbol: sym, targetWeight: tgtWeight, currentMV, desiredMV, deltaUSD };
      if (Math.abs(deltaUSD) < minTrade) {
        decision.skipReason = 'driftWithinBand';
        rebalanceDecisions.push(decision);
        return;
      }
      const qty = Math.floor(Math.abs(deltaUSD) / price);
      if (qty < 1) {
        decision.skipReason = 'wholeShareRounding';
        rebalanceDecisions.push(decision);
        return;
      }
      if (deltaUSD < 0) {
        // SELL path
        const heldQty = state.portfolio.holdings.find((h) => h.symbol === sym)?.quantity || 0;
        if (heldQty < 1) {
          decision.skipReason = 'noPosition';
          rebalanceDecisions.push(decision);
          return;
        }
        const sp = state.sleeves[sym] || { baseQty: heldQty, dislocationQty: 0, updatedAtISO: week.date };
        const desiredSell = qty;
        decision.sellProtectionApplied = false;
        decision.sellBlockedQty = 0;
        let sellFromBase = Math.min(sp.baseQty, desiredSell);
        let sellFromDislocation = 0;
        if (!protectFromSells && desiredSell > sellFromBase) {
          sellFromDislocation = Math.min(sp.dislocationQty || 0, desiredSell - sellFromBase);
        } else if (protectFromSells && desiredSell > sellFromBase) {
          decision.sellProtectionApplied = true;
          decision.sellBlockedQty = desiredSell - sellFromBase;
        }
        const totalSell = sellFromBase + sellFromDislocation;
        if (totalSell < 1) {
          decision.skipReason = 'sellsDisabled_dislocationSleeve';
          rebalanceDecisions.push(decision);
          return;
        }
        decision.finalQty = -totalSell;
    rebalanceDecisions.push(decision);
    // execute sell base portion
    if (sellFromBase > 0) {
      orders.push({ symbol: sym, side: 'SELL', quantity: sellFromBase, notionalUSD: sellFromBase * price, sleeve: 'base' });
      state.cashEvents.push({ type: 'ETF_SELL_CREDIT', amount: sellFromBase * price, reason: 'rebalance', symbol: sym, sleeve: 'base' });
      state.portfolio.cash += sellFromBase * price;
      const existing = state.portfolio.holdings.find((h) => h.symbol === sym);
      if (existing) existing.quantity -= sellFromBase;
      sp.baseQty = Math.max(0, sp.baseQty - sellFromBase);
    }
    if (sellFromDislocation > 0) {
      orders.push({ symbol: sym, side: 'SELL', quantity: sellFromDislocation, notionalUSD: sellFromDislocation * price, sleeve: 'dislocation' });
      state.cashEvents.push({ type: 'ETF_SELL_CREDIT', amount: sellFromDislocation * price, reason: 'rebalance', symbol: sym, sleeve: 'dislocation' });
      state.portfolio.cash += sellFromDislocation * price;
      const existing = state.portfolio.holdings.find((h) => h.symbol === sym);
      if (existing) existing.quantity -= sellFromDislocation;
      sp.dislocationQty = Math.max(0, (sp.dislocationQty || 0) - sellFromDislocation);
    }
    state.sleeves[sym] = sp;
    return;
  }
      // BUY path
      const cost = qty * price;
      decision.proposedQty = qty;
      if (cost > state.portfolio.cash) {
        decision.skipReason = 'noCash';
        rebalanceDecisions.push(decision);
        return;
      }
      const investedAfter = investedHoldingsForRebalance + cost;
      if (investedAfter > budgets.coreBudget) {
        decision.skipReason = 'coreCapReached';
        rebalanceDecisions.push(decision);
        return;
      }
      decision.finalQty = qty;
      rebalanceDecisions.push(decision);
      applyBuy({ symbol: sym, quantity: qty, estPrice: price }, 'base');
    });

    let dislocationAllocationDiagnostics: any = null;

    // Dislocation overlay buys during ADD with pacing (3-week staged)
    if (state.dislocation.phase === 'ADD' && tierEngaged) {
      const baseMV = Object.entries(state.sleeves).reduce((acc, [sym, s]) => acc + (s.baseQty || 0) * (pricesUsed[sym] || 0), 0);
      const dislocationMV = Object.entries(state.sleeves).reduce((acc, [sym, s]) => acc + (s.dislocationQty || 0) * (pricesUsed[sym] || 0), 0);
      const overlayTargetTotal = Math.max(0, investableEtfPoolUSD - baseMV);
      const stage = Math.min(3, Math.max(1, state.dislocation.addWeeksCompleted || 1));
      const plannedCumulative = overlayTargetTotal * (stage / 3);
      remainingEtfCapacityUSD = Math.max(0, investableEtfPoolUSD - (baseMV + dislocationMV));
      const allowedNew = Math.max(0, Math.min(plannedCumulative - dislocationMV, remainingEtfCapacityUSD));
      const overlayBudgetUSD = allowedNew;
      if (overlayBudgetUSD > 0) {
        const overlayUniversalTargets: Record<string, number> = { SPY: 0.7, QQQ: 0.3 };
        const overlayMappingRes = mapUniversalTargets(overlayUniversalTargets, pricesUsed, overlayBudgetUSD, proxyMap);
        const overlayExecEntries = Object.entries(overlayMappingRes.executedTargets || {});
        const overlayPlan =
          overlayExecEntries.length > 0
            ? planWholeShareExecution({
                targets: overlayExecEntries.map(([sym, w]) => ({
                  symbol: sym,
                  notionalUSD: overlayBudgetUSD * w,
                  priority: 1
                })),
                prices: pricesUsed,
                buyBudgetUSD: overlayBudgetUSD,
                minCashUSD: 0,
                allowPartial: true,
                minViablePositions: 1,
                maxAbsWeightError: 0.5
              })
            : {
                status: 'UNEXECUTABLE',
                selectedSymbols: [],
                orders: [],
                achievedWeights: {},
                targetWeights: {},
                leftoverCashUSD: overlayBudgetUSD,
                error: { maxAbsError: 1, l1Error: 1 },
                skipped: [],
                flags: [],
                substitutions: []
              };
        const perSymbol: Record<
          string,
          {
            targetWeight: number;
            desiredUSD: number;
            price: number;
            minShareCostUSD: number;
            affordable: boolean;
            executedQty: number;
            executedUSD: number;
            executedSymbol?: string;
            skipReason?: string;
          }
        > = {};
        overlayMappingRes.executionMapping.forEach((m) => {
          const targetWeight = overlayUniversalTargets[m.universalSymbol] || 0;
          const desiredUSD = overlayBudgetUSD * targetWeight;
          const execSym = m.executedSymbol || m.universalSymbol;
          const price = pricesUsed[execSym] || pricesUsed[m.universalSymbol] || 0;
          const executedOrders = overlayPlan.orders.filter((o: any) => o.symbol === execSym);
          const executedQty = executedOrders.reduce((acc: number, o: any) => acc + (o.quantity || 0), 0);
          const executedUSD = executedOrders.reduce(
            (acc: number, o: any) => acc + (o.quantity || 0) * (pricesUsed[o.symbol] || o.estPrice || 0),
            0
          );
          const skip = overlayPlan.skipped.find((s: any) => s.symbol === execSym);
          perSymbol[m.universalSymbol] = {
            targetWeight,
            desiredUSD,
            price,
            minShareCostUSD: price,
            affordable: price > 0 ? desiredUSD + 1e-6 >= price : false,
            executedQty,
            executedUSD,
            executedSymbol: execSym,
            skipReason: skip?.reason || (m.reason !== 'direct' && m.reason !== 'proxy' ? m.reason : undefined)
          };
        });
        dislocationAllocationDiagnostics = {
          budgetUSD: overlayBudgetUSD,
          remainingBudgetUSD: overlayPlan.leftoverCashUSD,
          targets: overlayUniversalTargets,
          perSymbol
        };
        overlayPlan.orders.forEach((o) => applyBuy(o, 'dislocation'));
      }
    }

    // Reintegration: atomic transfer dislocation -> base on entry
    if (state.dislocation.phase === 'REINTEGRATE' && !state.dislocation.reintegrated) {
      const reintegrationTransfers: any[] = [];
      Object.entries(state.sleeves).forEach(([sym, s]) => {
        if (s.dislocationQty && s.dislocationQty > 0) {
          reintegrationTransfers.push({ symbol: sym, quantity: s.dislocationQty });
          s.baseQty += s.dislocationQty;
          s.dislocationQty = 0;
          const holding = state.portfolio.holdings.find((h) => h.symbol === sym);
          if (holding) holding.quantity = s.baseQty;
        }
      });
      // clear fulfilled lots
      state.dislocationLots = state.dislocationLots.filter((lot) => lot.plannedReintegrateWeekIndex > idx);
      state.dislocation.reintegrated = true;
      if (reintegrationTransfers.length > 0) {
        state.cashEvents.push({ type: 'REINTEGRATE_TRANSFER', amount: 0, reason: 'dislocation_reintegrate', sleeve: 'dislocation' });
      }
    }

    // Options sleeves (harness only, reserve cash) with explicit arbitrator
    const investedHoldings = state.portfolio.holdings.reduce((acc, h) => acc + h.quantity * (pricesUsed[h.symbol] || 0), 0);
    const reserveBudget = budgets.reserveBudget;
    const markOption = (pos?: OptionPosition) =>
      pos ? optionMarketValue(pos, idx, pricesUsed[pos.underlying] || 0, volProxy) : { mark: 0, markPerShare: 0, weeksToExpiry: 0 };
    const syncReserveUsage = () => {
      state.reserveUsedInsurance = positionReserveAtCost(state.insurance.position);
      state.reserveUsedGrowth = positionReserveAtCost(state.growth.position);
    };
    const closeOption = (sleeve: 'insurance' | 'growth', reason: string) => {
      const sleeveState = sleeve === 'insurance' ? state.insurance : state.growth;
      if (!sleeveState.position) return { mark: 0, markPerShare: 0, weeksToExpiry: 0 };
      const markRes = markOption(sleeveState.position);
      state.cashEvents.push({ type: 'OPT_CLOSE_CREDIT', amount: markRes.mark, reason, symbol: sleeveState.position.underlying, sleeve });
      state.portfolio.cash += markRes.mark;
      sleeveState.state = 'INACTIVE';
      sleeveState.position = undefined;
      sleeveState.openedWeek = undefined;
      syncReserveUsage();
      return markRes;
    };
    const expireIfDue = (sleeve: 'insurance' | 'growth', sleeveState: OptionSleeveState) => {
      const pos = sleeveState.position;
      if (!pos) return false;
      const ttm = Math.max(0, pos.expiryWeek - idx);
      if (ttm <= 0) {
        state.cashEvents.push({ type: 'OPT_EXPIRE', amount: 0, reason: `${sleeve}_expire`, symbol: pos.underlying, sleeve });
        sleeveState.state = 'INACTIVE';
        sleeveState.position = undefined;
        sleeveState.openedWeek = undefined;
        syncReserveUsage();
        return true;
      }
      return false;
    };

    expireIfDue('insurance', state.insurance);
    expireIfDue('growth', state.growth);

    syncReserveUsage();
    const reserveInvariantViolations: string[] = [];
    const reserveUsedTotalPre = state.reserveUsedInsurance + state.reserveUsedGrowth;
    if (reserveBudget - reserveUsedTotalPre < -1e-6) reserveInvariantViolations.push('reserve_over_allocated_pre_trade');
    let reserveRemaining = Math.max(0, reserveBudget - reserveUsedTotalPre);
    const navNow = state.portfolio.cash + investedHoldings + markOption(state.insurance.position).mark + markOption(state.growth.position).mark;

    const insuranceOpenWindow = dislocationRisingEdge && !state.insuranceOpenedOnce && state.insurance.state === 'INACTIVE';
    const insuranceHoldAllowed = state.dislocation.phase !== 'INACTIVE';
    let insuranceTriggerReason: string | undefined = insuranceOpenWindow ? 'first_dislocation_week_rising_edge' : undefined;
    let insuranceReserveOnlyOk = true;
    let insuranceDiagnostics: OptionAllocationDiagnostics | undefined;
    let insuranceRes: any = {
      action: 'SKIP',
      spend: 0,
      mark: markOption(state.insurance.position).mark,
      markPerShare: markOption(state.insurance.position).markPerShare,
      position: state.insurance.position
    };

    if (state.insurance.position && !insuranceHoldAllowed && !insuranceOpenWindow) {
      const markRes = closeOption('insurance', 'insurance_close');
      insuranceRes = { action: 'CLOSE', spend: -markRes.mark, mark: 0, markPerShare: markRes.markPerShare, position: null, weeksToExpiry: markRes.weeksToExpiry };
    } else if (insuranceOpenWindow) {
      const underlying = baseConfig.optionsUnderlyings?.[0] || 'IWM';
      const uPrice = pricesUsed[underlying] || 0;
      const premiumPerShare = uPrice * 0.005 * volProxy;
      const costPerContract = premiumPerShare * contractMultiplier;
      const cappedBudget =
        (baseConfig.insuranceReserveMode || 'light') === 'full'
          ? Math.min(reserveRemaining, reserveBudget * (baseConfig.insurance?.spendPct ?? 1))
          : Math.min(navNow * 0.02, reserveBudget * 0.05, 200, reserveRemaining);
      const effectiveBudget = Math.min(reserveRemaining, Math.max(cappedBudget, costPerContract));
      const contracts = Math.floor(effectiveBudget / costPerContract);
      const skipReasonInsurance =
        contracts < 1 || effectiveBudget < costPerContract ? 'contractsRoundToZero' : undefined;
      if (skipReasonInsurance) {
        insuranceTriggerReason = 'skipped_insufficient_reserve';
        insuranceReserveOnlyOk = false;
        insuranceRes = {
          action: 'SKIP',
          spend: 0,
          mark: markOption(state.insurance.position).mark,
          position: state.insurance.position,
          skipReason: skipReasonInsurance
        };
      } else {
        const spend = contracts * costPerContract;
        if (spend > reserveRemaining + 1e-6) {
          reserveInvariantViolations.push('reserveExceeded_insurance_open');
          insuranceReserveOnlyOk = false;
        } else {
          const minWeeks = (baseConfig.insurance?.minMonths ?? 3) * 4;
          const maxWeeks = (baseConfig.insurance?.maxMonths ?? 6) * 4;
          const expiryWeek = idx + Math.min(Math.max(minWeeks, 12), maxWeeks);
          const pos: OptionPosition = {
            type: 'PUT',
            strike: uPrice * (baseConfig.insurance?.maxMoneyness ?? 1),
            expiryWeek,
            contracts,
            premiumPerShare,
            underlying,
            openedWeek: idx,
            openWeekISO: week.date
          };
          state.portfolio.cash -= spend;
          state.cashEvents.push({ type: 'OPT_OPEN_DEBIT', amount: -spend, reason: 'insurance_open', symbol: underlying, sleeve: 'insurance' });
          state.insurance = { state: 'DEPLOYED', position: pos, openedWeek: idx };
          syncReserveUsage();
          insuranceRes = { action: 'OPEN', spend, mark: spend, markPerShare: premiumPerShare, position: pos, weeksToExpiry: Math.max(0, pos.expiryWeek - idx) };
          reserveRemaining = Math.max(0, reserveBudget - (state.reserveUsedInsurance + state.reserveUsedGrowth));
        }
      }
      insuranceDiagnostics = {
        reserveBudgetUSD: reserveBudget,
        reserveRemainingUSD: reserveRemaining,
        premiumPerShare,
        requiredPremiumUSD: contracts * costPerContract,
        contractsProposed: contracts,
        contractsFinal: insuranceRes.action === 'OPEN' ? contracts : 0,
        skipReason: insuranceRes.skipReason
      };
    } else if (state.insurance.position) {
      const markRes = markOption(state.insurance.position);
      insuranceRes = { action: 'HOLD', spend: 0, mark: markRes.mark, markPerShare: markRes.markPerShare, position: state.insurance.position, weeksToExpiry: markRes.weeksToExpiry };
    }

    if (insuranceOpenWindow) {
      state.insuranceOpenedOnce = true;
    }

    const growthOpenWindow =
      baseRegime === 'RISK_ON' &&
      state.dislocation.phase === 'INACTIVE' &&
      state.insurance.state === 'INACTIVE' &&
      state.growth.state === 'INACTIVE';
    const growthHoldAllowed = baseRegime === 'RISK_ON' && state.dislocation.phase === 'INACTIVE' && state.insurance.state === 'INACTIVE';
    let growthRes: any = { action: 'SKIP', spend: 0, mark: markOption(state.growth.position).mark, position: state.growth.position };
    let growthDiagnostics: OptionAllocationDiagnostics | undefined;
    if (state.growth.position && !growthHoldAllowed) {
      const markRes = closeOption('growth', 'growth_close');
      growthRes = { action: 'CLOSE', spend: -markRes.mark, mark: 0, markPerShare: markRes.markPerShare, position: null, weeksToExpiry: markRes.weeksToExpiry };
    } else if (growthOpenWindow) {
      const underlying = baseConfig.hedgeProxyPolicy?.growthPreferred?.[0] || baseConfig.optionsUnderlyings?.[0] || 'IWM';
      const uPrice = pricesUsed[underlying] || 0;
      const premiumPerShare = uPrice * 0.02 * volProxy;
      const costPerContract = premiumPerShare * contractMultiplier;
      const cappedBudget = Math.min(reserveRemaining, reserveBudget * (baseConfig.growth?.spendPct ?? 0.2));
      const effectiveBudget = Math.min(reserveRemaining, Math.max(cappedBudget, costPerContract));
      const contracts = Math.floor(effectiveBudget / costPerContract);
      const skipReasonGrowth = contracts < 1 || effectiveBudget < costPerContract ? 'contractsRoundToZero' : undefined;
      if (skipReasonGrowth) {
        growthRes = { action: 'SKIP', spend: 0, mark: markOption(state.growth.position).mark, position: state.growth.position, skipReason: skipReasonGrowth };
      } else {
        const spend = contracts * costPerContract;
        if (spend > reserveRemaining + 1e-6) {
          reserveInvariantViolations.push('reserveExceeded_growth_open');
        } else {
          const minWeeks = (baseConfig.growth?.minMonths ?? 3) * 4;
          const maxWeeks = (baseConfig.growth?.maxMonths ?? 6) * 4;
          const expiryWeek = idx + Math.min(Math.max(minWeeks, 12), maxWeeks);
          const pos: OptionPosition = {
            type: 'CALL',
            strike: uPrice * (baseConfig.growth?.minMoneyness ?? 1.03),
            expiryWeek,
            contracts,
            premiumPerShare,
            underlying,
            openedWeek: idx,
            openWeekISO: week.date
          };
          state.portfolio.cash -= spend;
          state.cashEvents.push({ type: 'OPT_OPEN_DEBIT', amount: -spend, reason: 'growth_open', symbol: underlying, sleeve: 'growth' });
          state.growth = { state: 'DEPLOYED', position: pos, openedWeek: idx };
          syncReserveUsage();
          growthRes = { action: 'OPEN', spend, mark: spend, markPerShare: premiumPerShare, position: pos, weeksToExpiry: Math.max(0, pos.expiryWeek - idx) };
          reserveRemaining = Math.max(0, reserveBudget - (state.reserveUsedInsurance + state.reserveUsedGrowth));
        }
      }
      growthDiagnostics = {
        reserveBudgetUSD: reserveBudget,
        reserveRemainingUSD: reserveRemaining,
        premiumPerShare,
        requiredPremiumUSD: contracts * costPerContract,
        contractsProposed: contracts,
        contractsFinal: growthRes.action === 'OPEN' ? contracts : 0,
        skipReason: growthRes.skipReason
      };
    } else if (state.growth.position) {
      const markRes = markOption(state.growth.position);
      growthRes = { action: 'HOLD', spend: 0, mark: markRes.mark, markPerShare: markRes.markPerShare, position: state.growth.position, weeksToExpiry: markRes.weeksToExpiry };
    }

    syncReserveUsage();
    const reserveUsedTotal = state.reserveUsedInsurance + state.reserveUsedGrowth;
    const reserveRemainingFinal = reserveBudget - reserveUsedTotal;
    if (reserveRemainingFinal < -1e-6) reserveInvariantViolations.push('reserve_over_allocated_post_trade');
    const reserveInvariantOk = reserveInvariantViolations.length === 0 && reserveRemainingFinal >= -1e-6;
    insuranceReserveOnlyOk = insuranceReserveOnlyOk && state.reserveUsedInsurance <= reserveBudget;

    const optionsMarks: { insurance?: any; growth?: any } = {};
    if (state.insurance.position) {
      optionsMarks.insurance = markOption(state.insurance.position);
    }
    if (state.growth.position) {
      optionsMarks.growth = markOption(state.growth.position);
    }
    const optionsMarketValue = (optionsMarks.insurance?.mark || 0) + (optionsMarks.growth?.mark || 0);

    // NAV invariants (post-trade)
    const holdingsMarketValue = state.portfolio.holdings.reduce((acc, h) => acc + h.quantity * (pricesUsed[h.symbol] || 0), 0);
    const nav = state.portfolio.cash + holdingsMarketValue + optionsMarketValue;
    state.portfolio.equity = nav;
    const invariantViolations: string[] = [];
    if (!Number.isFinite(nav)) invariantViolations.push('nav not finite');
    // cash reconciliation
    const expectedCash = priorCash + [...state.cashEvents, ...conversionCashEvents].reduce((acc, ev) => acc + ev.amount, 0);
    const cashDiff = (state.portfolio.cash || 0) - expectedCash;
    if (Math.abs(cashDiff) > 0.01) {
      invariantViolations.push('Unexplained cash delta');
    }
    const sumOptionMarks = (optionsMarks.insurance?.mark || 0) + (optionsMarks.growth?.mark || 0);
    if (Math.abs(optionsMarketValue - sumOptionMarks) > 0.01) {
      invariantViolations.push('optionsMarketValue mismatch');
    }
    if (!reserveInvariantOk) {
      reserveInvariantViolations.forEach((v) => invariantViolations.push(v));
    }
    const cashReconciliationOk = invariantViolations.findIndex((v) => v.includes('Unexplained cash delta')) === -1;
    const cashEventsOut = [...state.cashEvents, ...conversionCashEvents];
    const cashDeltaFromEvents = cashEventsOut.reduce((acc, ev) => acc + ev.amount, 0);
    const invariantOk = invariantViolations.length === 0;

    const mdHealth = idx === 0 ? await marketDataHealthcheck(week1.requestSymbols) : undefined;
    const acctHealth = idx === 0 ? await accountApiHealthcheck() : undefined;

    // Net orders (rebalance + conversion) to remove churn (BUY+SELL same symbol/sleeve)
    const netOrdersMap: Record<string, { buy: number; sell: number; price: number; sleeve: string; symbol: string }> = {};
    const allOrders = [...orders, ...conversionOrders];
    const allCashEvents = [...state.cashEvents, ...conversionCashEvents];
    allOrders.forEach((o) => {
      const key = `${o.sleeve}:${o.symbol}`;
      const entry =
        netOrdersMap[key] || { buy: 0, sell: 0, price: o.notionalUSD && o.quantity ? o.notionalUSD / o.quantity : 0, sleeve: o.sleeve, symbol: o.symbol };
      if (o.side === 'BUY') entry.buy += o.quantity;
      else if (o.side === 'SELL') entry.sell += o.quantity;
      entry.price = o.notionalUSD && o.quantity ? o.notionalUSD / o.quantity : entry.price;
      netOrdersMap[key] = entry;
    });
    const netOrders: any[] = [];
    Object.values(netOrdersMap).forEach((e) => {
      const netQty = e.buy - e.sell;
      if (netQty > 0) netOrders.push({ symbol: e.symbol, side: 'BUY', quantity: netQty, notionalUSD: netQty * (e.price || 0), sleeve: e.sleeve });
      else if (netQty < 0) netOrders.push({ symbol: e.symbol, side: 'SELL', quantity: Math.abs(netQty), notionalUSD: Math.abs(netQty) * (e.price || 0), sleeve: e.sleeve });
    });
    const combinedOrders = netOrders;

    results.push({
      asOf: week.date,
      priceSource,
      pricesUsed,
      priceSourceDetail: idx === 0 ? week1.priceSourceDetail : undefined,
      week1QuoteProbe: idx === 0 ? week1.probe : undefined,
      marketDataApiHealthcheck: mdHealth,
      marketDataApiFunctional: mdHealth?.ok,
      accountApiHealthcheck: acctHealth,
      accountApiFunctional: acctHealth?.ok,
      episodeStartReason,
      episodeNotStartedReason,
      scenarioName: scenarioToUse.name || scenarioKey,
      scenarioWeekIndex: idx,
      baseRegime,
      baseRegimeRisingEdge,
      baseRegimePolicy,
      navPreInfusion,
      navPostInfusion,
      budgetsPreInfusion,
      dislocation: {
        tier: dislocation.tier,
        tierEngaged,
        phase: state.dislocation.phase,
        episodeStartWeekISO: state.dislocation.episodeStartWeek !== undefined ? timeline[state.dislocation.episodeStartWeek] : null,
        addWeekIndex: state.dislocation.phase === 'ADD' ? Math.max(0, state.dislocation.addWeeksCompleted - 1) : null,
        holdWeekIndex: state.dislocation.phase === 'HOLD' ? Math.max(0, (state.dislocation.holdWeeksCompleted || 0) - 1) : null,
        allowAdd: state.dislocation.phase === 'ADD' && tierEngaged,
        protectFromSells: state.dislocation.phase === 'ADD' || state.dislocation.phase === 'HOLD',
        allowReintegration: state.dislocation.phase === 'REINTEGRATE',
        dislocationRisingEdge
      },
      budgets: {
        coreBudget: budgets.coreBudget,
        reserveBudget: budgets.reserveBudget,
        baseAllowedInvest,
        dislocationAllowedInvest,
        baseExposureCapPct: baseRegimePolicy.baseExposureCapPct
      },
      universalTargets,
      targetRanking: targetResult.ranking,
      proxyTargets,
      executionMapping,
      currentProxyWeights,
      driftByProxy,
      mappingDiagnostics,
      rebalanceDecisions,
      orders: combinedOrders,
      overlayOrders: combinedOrders.filter((o) => o.sleeve === 'dislocation'),
      targetsSource: {
        module: 'scripts/simPortfolio',
        fn: 'computeDynamicTargetsFromRegimes',
        policyKey: baseRegime,
        notes: 'momentum_plus_regime_tilts'
      },
      conversionDiagnostics: {
        conversionActions,
        proxyPairs: proxyPairs.map((p) => `${p.universal}->${p.proxy}`),
        noopSuppressed: proxyMap ? Object.entries(proxyMap).filter(([u, proxies]) => proxies[0] === u).length : 0
      },
      dislocationAllocationDiagnostics,
      insurance: {
        state: state.insurance.state,
        action: insuranceRes.action,
        spend: insuranceRes.spend || 0,
        mark: insuranceRes.mark ?? optionsMarks.insurance?.mark ?? 0,
        markPerShare: insuranceRes.markPerShare || optionsMarks.insurance?.markPerShare,
        weeksToExpiry: insuranceRes.weeksToExpiry ?? optionsMarks.insurance?.weeksToExpiry,
        position: state.insurance.position,
        insuranceTriggerReason,
        insuranceReserveOnlyOk,
        skipReason: insuranceRes.skipReason,
        allocationDiagnostics: insuranceDiagnostics
      },
      growth: {
        state: state.growth.state,
        action: growthRes.action,
        spend: growthRes.spend || 0,
        mark: growthRes.mark ?? optionsMarks.growth?.mark ?? 0,
        markPerShare: growthRes.markPerShare || optionsMarks.growth?.markPerShare,
        weeksToExpiry: growthRes.weeksToExpiry ?? optionsMarks.growth?.weeksToExpiry,
        position: state.growth.position,
        skipReason: growthRes.skipReason,
        allocationDiagnostics: growthDiagnostics
      },
      cash: state.portfolio.cash,
      holdingsMarketValue,
      optionsMarketValue,
      nav,
      equity: nav,
      priorCash,
      cashEvents: cashEventsOut,
      cashDeltaFromEvents,
      cashReconciliationOk,
      cashReconciliationDiff: (state.portfolio.cash || 0) - expectedCash,
      invariantOk,
      invariantViolations,
      holdings: JSON.parse(JSON.stringify(state.portfolio.holdings)),
      sleeves: JSON.parse(JSON.stringify(state.sleeves)),
      dislocationLots: JSON.parse(JSON.stringify(state.dislocationLots)),
      reserveUsedInsurance: state.reserveUsedInsurance,
      reserveUsedGrowth: state.reserveUsedGrowth,
      reserveUsedTotal,
      reserveBudget: budgets.reserveBudget,
      reserveRemaining: reserveRemainingFinal,
      reserveInvariantOk,
      reserveInvariantViolations
    });

    // prepare for next week
    state.prevCash = state.portfolio.cash;
    state.cashEvents = [];
  }

  return results;
};

if (require.main === module) {
  runSimulation({}).then((res) => {
    res.forEach((w) => {
      console.log(
        `${w.asOf} phase=${w.dislocation.phase} tier=${w.dislocation.tier} source=${w.priceSource} cash=${w.cash.toFixed(
          2
        )} nav=${w.nav.toFixed(2)} overlayBuys=${w.overlayOrders.length} invariantOk=${w.invariantOk}`
      );
    });
  });
}
