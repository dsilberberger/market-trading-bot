import path from 'path';
import fs from 'fs';
import {
  BotConfig,
  DataQualityFlag,
  ContextMeta,
  LLMContextPacket,
  MacroSeries,
  RegimeContext,
  RunInputs,
  SymbolFeature
} from '../core/types';
import { ensureDir, loadUniverse, writeJSONFile, loadConfig } from '../core/utils';
import { MarketDataProvider, PriceBar } from '../data/marketData.types';
import { getMarketDataProvider } from '../data/marketData';
import { getBroker } from '../broker/broker';
import { ETradeBroker } from '../broker/etrade/etradeBroker';
import { ETradeClient } from '../integrations/etradeClient';
import { getStatus } from '../broker/etrade/authService';
import { writeContextPacket } from '../integrations/fredClient';
import { getFredClient } from '../macro';
import { getFinnhubClient } from '../data/finnhubClient';

const safeLoadJson = <T>(filePath: string | undefined, fallback: T): T => {
  if (!filePath) return fallback;
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
};

const HISTORY_LOOKBACK_DAYS = 250;
const MAX_CONTEXT_BYTES = Number(process.env.CONTEXT_PACKET_MAX_BYTES || 120000);
const DEFAULT_CONF_THRESHOLD = 0.6;
const MACRO_MONTHS_LIMIT = Number(process.env.MACRO_MONTHS_LIMIT || 24);

export interface ContextOptions {
  series?: string[];
  lookbackDays?: number;
  mode?: string;
  useExistingInputs?: boolean;
}

const pctChange = (a: number, b: number) => {
  if (!Number.isFinite(a) || a === 0) return 0;
  return (b - a) / a;
};

const sortedBars = (bars: PriceBar[]): PriceBar[] => [...bars].sort((a, b) => (a.date < b.date ? -1 : 1));

const medianGapDays = (bars: PriceBar[]): number | undefined => {
  if (!bars || bars.length < 2) return undefined;
  const sorted = sortedBars(bars);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const diff = (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / (1000 * 60 * 60 * 24);
    gaps.push(diff);
  }
  const sortedGaps = gaps.sort((a, b) => a - b);
  const mid = Math.floor(sortedGaps.length / 2);
  return sortedGaps.length % 2 ? sortedGaps[mid] : (sortedGaps[mid - 1] + sortedGaps[mid]) / 2;
};

const computeReturn = (bars: PriceBar[], lookbackBars: number): number | undefined => {
  if (!bars.length) return undefined;
  const sorted = sortedBars(bars);
  const end = sorted[sorted.length - 1];
  const startIdx = sorted.length - 1 - lookbackBars;
  if (startIdx < 0) return undefined;
  const start = sorted[startIdx];
  return pctChange(start.close, end.close);
};

const computeVol = (bars: PriceBar[], windowBars: number): number | undefined => {
  if (!bars.length) return undefined;
  const sorted = sortedBars(bars);
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const r = pctChange(sorted[i - 1].close, sorted[i].close);
    returns.push(r);
  }
  const tail = returns.slice(-windowBars);
  if (!tail.length) return undefined;
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const variance = tail.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / tail.length;
  const vol = Math.sqrt(variance);
  return vol * Math.sqrt(252);
};

const movingAverage = (bars: PriceBar[], window: number): number | undefined => {
  if (!bars.length) return undefined;
  const sorted = sortedBars(bars);
  const tail = sorted.slice(-window);
  if (!tail.length) return undefined;
  return tail.reduce((a, b) => a + b.close, 0) / tail.length;
};

const maxDrawdown = (bars: PriceBar[]): number | undefined => {
  if (!bars.length) return undefined;
  const sorted = sortedBars(bars);
  let peak = sorted[0].close;
  let mdd = 0;
  for (const b of sorted) {
    if (b.close > peak) peak = b.close;
    const dd = (b.close - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return Math.abs(mdd);
};

const percentile = (val: number | undefined, values: number[]): number | undefined => {
  if (val === undefined || !values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = sorted.findIndex((v) => v >= val);
  if (idx === -1) return 1;
  return idx / Math.max(1, sorted.length - 1);
};

const bucketize = (pct?: number): 'low' | 'mid' | 'high' | 'unknown' => {
  if (pct === undefined || pct === null || Number.isNaN(pct)) return 'unknown';
  if (pct < 0.33) return 'low';
  if (pct > 0.66) return 'high';
  return 'mid';
};

const trimMacroSeries = (series: MacroSeries[], asOf: string, months: number): MacroSeries[] => {
  const asOfDate = new Date(asOf);
  const cutoff = new Date(asOfDate);
  cutoff.setMonth(cutoff.getMonth() - months);
  return series.map((s) => ({
    ...s,
    points: (s.points || []).filter((p) => new Date(p.date) >= cutoff)
  }));
};

type Round0Diagnostic = {
  symbol: string;
  price: number;
  samples: number;
  uniqueCloses: number;
  min?: number;
  max?: number;
  last?: number;
};

type Round0Summary = {
  symbols: Round0Diagnostic[];
  macroLatest?: Record<string, string | undefined>;
  macroLagDays?: Record<string, number | undefined>;
  newsCount?: number;
};

const summarizeHistory = (bars: PriceBar[]): { samples: number; uniqueCloses: number; min?: number; max?: number; last?: number } => {
  const closes = (bars || []).map((b) => b.close).filter((v) => Number.isFinite(v));
  const samples = closes.length;
  if (!samples) return { samples: 0, uniqueCloses: 0 };
  const unique = new Set(closes.map((c) => Number(c.toFixed(4)))).size;
  return { samples, uniqueCloses: unique, min: Math.min(...closes), max: Math.max(...closes), last: closes.at(-1) };
};

export const computeMacroLagFlags = (
  asOf: string,
  macro: MacroSeries[] | undefined,
  policy: 'flags_warn' | 'summary_only',
  warnDays: number,
  errorDays?: number
): { flags: DataQualityFlag[]; macroLatest: Record<string, string | undefined>; macroLagDays: Record<string, number | undefined> } => {
  const macroLatest: Record<string, string | undefined> = {};
  const macroLagDays: Record<string, number | undefined> = {};
  const flags: DataQualityFlag[] = [];
  if (macro?.length) {
    macro.forEach((m) => {
      const last = m.points?.[m.points.length - 1];
      macroLatest[m.id] = last?.date;
      if (last?.date) {
        const diff = (new Date(asOf).getTime() - new Date(last.date).getTime()) / (1000 * 60 * 60 * 24);
        const lagDays = Math.round(diff);
        macroLagDays[m.id] = lagDays;
        if (policy === 'flags_warn' && lagDays > warnDays) {
          const severity = errorDays && lagDays > errorDays ? 'error' : 'warn';
          flags.push({
            code: 'MACRO_LAGGED',
            severity,
            message: `${m.id} is ${lagDays} days old`,
            observed: { series: m.id, lagDays, latestDate: last.date },
            action: 'warn'
          });
        }
      }
    });
  }
  return { flags, macroLatest, macroLagDays };
};

const evaluateRound0 = (
  asOf: string,
  universe: string[],
  quotes: Record<string, number>,
  history: Record<string, PriceBar[]>,
  macro: MacroSeries[] | undefined,
  cfg: BotConfig,
  mode: string = 'paper'
): { flags: DataQualityFlag[]; diagnostics: Round0Diagnostic[]; summary: Round0Summary } => {
  const diagnostics: Round0Diagnostic[] = universe.map((symbol) => {
    const stats = summarizeHistory(history[symbol] || []);
    return {
      symbol,
      price: quotes[symbol] ?? 0,
      ...stats
    };
  });

  const flags: DataQualityFlag[] = [];
  const priceBuckets = new Map<number, string[]>();
  diagnostics.forEach((d) => {
    if (!Number.isFinite(d.price)) return;
    const bucket = Number(d.price.toFixed(2));
    priceBuckets.set(bucket, [...(priceBuckets.get(bucket) || []), d.symbol]);
  });
  for (const [price, symbols] of priceBuckets.entries()) {
    if (symbols.length >= 3) {
      flags.push({
        code: 'MD_DUPLICATE_QUOTES',
        severity: 'error',
        message: `${symbols.length} symbols share identical quote ${price}`,
        symbols,
        observed: { price },
        action: 'block'
      });
    }
  }

  diagnostics.forEach((d) => {
    if (!d.samples) {
      flags.push({
        code: 'MISSING_HISTORY',
        severity: 'error',
        message: `Missing history for ${d.symbol}`,
        symbols: [d.symbol],
        action: 'block'
      });
      return;
    }
    if (d.uniqueCloses < 5) {
      flags.push({
        code: 'FLAT_HISTORY',
        severity: 'error',
        message: `Insufficient unique closes for ${d.symbol}`,
        symbols: [d.symbol],
        observed: { uniqueCloses: d.uniqueCloses },
        action: 'block'
      });
    }
  });

  if (!macro?.length) {
    flags.push({
      code: 'MACRO_MISSING',
      severity: 'error',
      message: 'Macro series missing',
      action: 'block'
    });
  }

  if (mode === 'live' && (process.env.MARKET_DATA_PROVIDER || 'stub') === 'stub') {
    flags.push({
      code: 'STUB_IN_LIVE_MODE',
      severity: 'error',
      message: 'Stub provider in live mode',
      action: 'block'
    });
  }

  const policy = cfg.round0MacroLagPolicy || 'flags_warn';
  const warnDays = cfg.macroLagWarnDays ?? 45;
  const errorDays = cfg.macroLagErrorDays ?? undefined;
  const macroLagResult = computeMacroLagFlags(asOf, macro, policy, warnDays, errorDays);
  flags.push(...macroLagResult.flags);

  return { flags, diagnostics, summary: { symbols: diagnostics, macroLatest: macroLagResult.macroLatest, macroLagDays: macroLagResult.macroLagDays } };
};

export const buildFeatures = (
  universe: string[],
  quotes: Record<string, number>,
  history: Record<string, PriceBar[]>,
  flags: DataQualityFlag[]
): SymbolFeature[] => {
  const features: SymbolFeature[] = [];
  const volSet: number[] = [];
  const ret60Set: number[] = [];
  const firstWithHistory = universe.find((s) => (history[s] || []).length > 1);
  const medianGap = firstWithHistory ? medianGapDays(history[firstWithHistory]) : undefined;
  const isWeekly = medianGap !== undefined && medianGap >= 5;
  if (isWeekly) {
    flags.push({
      code: 'WEEKLY_BARS_DETECTED',
      severity: 'info',
      message: 'History appears weekly; returns/vol use weekly windows',
      action: 'warn'
    });
  }
  const barInterval: '1d' | '1w' = isWeekly ? '1w' : '1d';
  const win5 = isWeekly ? 1 : 5; // 1 bar ~ 1w
  const win20 = isWeekly ? 4 : 20; // ~1 month
  const win60 = isWeekly ? 12 : 60; // ~3 months
  const volWindow = isWeekly ? 8 : 20; // ~8w vs 20d
  const ma50Bars = isWeekly ? 10 : 50;
  const ma200Bars = isWeekly ? 40 : 200;
  const featureWarn = isWeekly ? 24 : 120;
  const featureBlock = isWeekly ? 12 : 60;
  const pctInfoThresh = isWeekly ? 52 : 260;
  const pctWarnThresh = isWeekly ? 26 : 130;
  for (const symbol of universe) {
    const bars = history[symbol] || [];
    const samples = bars.length;
    const uniqueCloses = summarizeHistory(bars).uniqueCloses;
    const ret5 = computeReturn(bars, win5);
    const ret20 = computeReturn(bars, win20);
    const ret60 = computeReturn(bars, win60);
    const vol20 = computeVol(bars, volWindow);
    const mdd60 = maxDrawdown(bars);
    const ma50 = movingAverage(bars, ma50Bars);
    const ma200 = movingAverage(bars, ma200Bars);
    const price = quotes[symbol] ?? 0;
    const feature: SymbolFeature = {
      symbol,
      price,
      barInterval,
      return5d: ret5,
      return20d: ret20,
      return60d: ret60,
      realizedVol20d: vol20,
      maxDrawdown60d: mdd60,
      trend: price && ma50 ? (price > ma50 ? 'up' : 'down') : undefined,
      above50dma: ma50 ? price > ma50 : undefined,
      above200dma: ma200 ? price > ma200 : undefined,
      dma50_gt_dma200: ma50 && ma200 ? ma50 > ma200 : undefined,
      ma50,
      ma200,
      historySamples: samples,
      historyUniqueCloses: uniqueCloses
    };
    features.push(feature);
    if (vol20 !== undefined) volSet.push(vol20);
    if (ret60 !== undefined) ret60Set.push(ret60);
    if (samples < featureBlock) {
      flags.push({
        code: 'INSUFFICIENT_HISTORY_FOR_FEATURES',
        severity: 'error',
        message: `Insufficient history for ${symbol}`,
        symbols: [symbol],
        observed: { samples, uniqueCloses, barInterval, thresholdSamples: featureBlock },
        action: 'block'
      });
    } else if (samples < featureWarn || uniqueCloses < 10) {
      flags.push({
        code: 'INSUFFICIENT_HISTORY_FOR_FEATURES',
        severity: 'warn',
        message: `Limited history for ${symbol}`,
        symbols: [symbol],
        observed: { samples, uniqueCloses, barInterval, thresholdSamples: featureWarn },
        action: 'warn'
      });
    }
    if (samples < pctInfoThresh) {
      flags.push({
        code: 'COARSE_PERCENTILES',
        severity: samples < pctWarnThresh ? 'warn' : 'info',
        message: `Percentiles coarse for ${symbol}`,
        symbols: [symbol],
        observed: { samples, barInterval, percentileInfoThreshold: pctInfoThresh, percentileWarnThreshold: pctWarnThresh },
        action: 'warn'
      });
    }
  }
  for (const f of features) {
    f.return60dPctile = ret60Set.length >= 2 ? percentile(f.return60d, ret60Set) : null as any;
    f.vol20dPctile = volSet.length >= 2 ? percentile(f.realizedVol20d, volSet) : null as any;
    f.return60dPctileBucket = bucketize(f.return60dPctile ?? undefined);
    f.vol20dPctileBucket = bucketize(f.vol20dPctile ?? undefined);
    if (f.return60dPctileBucket === 'unknown' || f.vol20dPctileBucket === 'unknown') {
      flags.push({
        code: 'PERCENTILE_UNRELIABLE',
        severity: 'warn',
        message: `Percentiles unreliable for ${f.symbol}`,
        symbols: [f.symbol],
        observed: {
          return60dPctile: f.return60dPctile,
          vol20dPctile: f.vol20dPctile,
          samples: f.historySamples,
          uniqueCloses: f.historyUniqueCloses
        },
        action: 'warn'
      });
    }
  }
  return features;
};

const buildMacroPolicy = (macro: MacroSeries[], flags: DataQualityFlag[]): Record<string, unknown> => {
  const latest = (series?: MacroSeries) => series?.points?.[series.points.length - 1];
  const trend3 = (series?: MacroSeries) => {
    if (!series?.points || series.points.length < 3) return undefined;
    const tail = series.points.slice(-3);
    return pctChange(tail[0].value, tail[tail.length - 1].value);
  };
  const find = (id: string) => macro.find((m) => m.id.toUpperCase() === id.toUpperCase());
  const inflation = find('CPIAUCSL');
  const unrate = find('UNRATE');
  const ff = find('FEDFUNDS');
  const dgs10 = find('DGS10');
  const policy = {
    inflation: {
      latest: latest(inflation)?.value,
      trend3: trend3(inflation)
    },
    unemployment: {
      latest: latest(unrate)?.value,
      trend3: trend3(unrate)
    },
    policyRate: {
      latest: latest(ff)?.value,
      trend3: trend3(ff)
    },
    yield10y: {
      latest: latest(dgs10)?.value,
      change3m: trend3(dgs10)
    }
  };
  if (!inflation?.points?.length)
    flags.push({ code: 'MISSING_INFLATION_SERIES', severity: 'warn', message: 'Missing inflation series' });
  if (!unrate?.points?.length)
    flags.push({ code: 'MISSING_UNEMPLOYMENT_SERIES', severity: 'warn', message: 'Missing unemployment series' });
  return policy;
};

export const buildRegimes = (
  asOf: string,
  features: SymbolFeature[],
  macro: MacroSeries[],
  cfg: BotConfig
): { regimes: RegimeContext; flags: DataQualityFlag[] } => {
  const flags: DataQualityFlag[] = [];
  const spy = features.find((f) => f.symbol === 'SPY');
  const volBucket = spy?.vol20dPctileBucket ?? 'unknown';
  const volPct = spy?.vol20dPctile ?? 0.5;
  const ret60 = spy?.return60d ?? 0;
  const retBucket = spy?.return60dPctileBucket ?? 'unknown';
  const above200 = spy?.above200dma ?? false;
  const bucketToScore = (b: string | undefined) => (b === 'high' ? 0.8 : b === 'mid' ? 0.5 : b === 'low' ? 0.2 : 0.4);
  const volScore = bucketToScore(volBucket);
  const retScore = bucketToScore(retBucket);
  let equityConf = Math.min(1, Math.max(0.2, Math.abs(ret60) * 5 + (above200 ? 0.2 : 0)));
  if (retBucket === 'unknown' || volBucket === 'unknown') {
    equityConf = Math.min(equityConf, 0.4);
  }
  let equityLabel: 'risk_on' | 'risk_off' | 'neutral' = 'neutral';
  if (ret60 > 0.03 && above200) equityLabel = 'risk_on';
  else if (ret60 < -0.02 || volScore > 0.7) equityLabel = 'risk_off';
  const equityTransition = volBucket === 'unknown' || volScore > 0.7 ? 'elevated' : 'low';

  const volLabel: 'low' | 'rising' | 'stressed' = volScore > 0.8 ? 'stressed' : volScore > 0.6 ? 'rising' : 'low';
  let volConf = Math.min(1, Math.max(0.3, Math.abs(volPct - 0.5) * 2));
  if (volBucket === 'unknown') volConf = Math.min(volConf, 0.4);

  const policy = cfg.round0MacroLagPolicy || 'flags_warn';
  const warnDays = cfg.macroLagWarnDays ?? 45;
  const macroLagResult = computeMacroLagFlags(asOf, macro, policy, warnDays, cfg.macroLagErrorDays);
  const dgs10 = macro.find((m) => m.id.toUpperCase() === 'DGS10');
  const tenYrTrend =
    dgs10?.points && dgs10.points.length > 3 ? pctChange(dgs10.points.at(-3)!.value, dgs10.points.at(-1)!.value) : 0;
  const ratesLabel: 'rising' | 'falling' | 'stable' = tenYrTrend > 0.01 ? 'rising' : tenYrTrend < -0.01 ? 'falling' : 'stable';
  const ratesStance: 'restrictive' | 'neutral' | 'accommodative' = (dgs10?.points?.at(-1)?.value ?? 3) > 3.5 ? 'restrictive' : 'neutral';
  let ratesConf = Math.min(1, Math.max(0.3, Math.abs(tenYrTrend) * 10));
  const breadthLabel: 'broad' | 'concentrated' | 'unknown' = features.length > 4 ? 'broad' : 'unknown';
  if (breadthLabel === 'unknown')
    flags.push({ code: 'BREADTH_UNKNOWN', severity: 'warn', message: 'Breadth unknown (too few features)' });

  if (equityConf < DEFAULT_CONF_THRESHOLD)
    flags.push({
      code: 'LOW_EQUITY_CONFIDENCE',
      severity: 'warn',
      message: 'Equity regime confidence below threshold',
      observed: { equityConf }
    });

  if (policy === 'summary_only') {
    const laggedSeries = Object.entries(macroLagResult.macroLagDays).filter(([, d]) => (d ?? 0) > warnDays);
    if (laggedSeries.length) {
      flags.push({
        code: 'MACRO_LAG_IMPACTING_CONFIDENCE',
        severity: 'warn',
        message: `Macro series lagged: ${laggedSeries.map(([k]) => k).join(', ')}`,
        observed: { laggedSeries },
        action: 'warn'
      });
      ratesConf = Math.min(ratesConf, 0.5);
      equityConf = Math.min(equityConf, 0.5);
    }
  }

  const regimes: RegimeContext = {
    growth: equityLabel === 'risk_on' ? 'up' : equityLabel === 'risk_off' ? 'down' : 'flat',
    inflation: ratesStance === 'restrictive' ? 'up' : 'flat',
    policy: ratesStance === 'restrictive' ? 'tightening' : 'neutral',
    risk: equityLabel === 'risk_off' ? 'off' : 'on',
    equityRegime: {
      label: equityLabel,
      confidence: equityConf,
      transitionRisk: equityTransition,
      supports: {
        spyRet60d: ret60,
        spyRet60dPctile: spy?.return60dPctile ?? null,
        spyRet60dBucket: retBucket,
        spyVolPctile: spy?.vol20dPctile ?? null,
        spyVolPctileBucket: volBucket,
        spyTrend: spy?.trend,
        historySamples: spy?.historySamples,
        historyUniqueCloses: spy?.historyUniqueCloses
      }
    },
    volRegime: { label: volLabel, confidence: volConf },
    ratesRegime: { label: ratesLabel, stance: ratesStance, confidence: ratesConf },
    breadth: breadthLabel
  };
  return { regimes, flags };
};

const buildEligibility = (
  features: SymbolFeature[],
  portfolioEquity: number,
  config: BotConfig,
  proxies: Record<string, string[]>
): {
  eligibility: Record<
    string,
    {
      tradable: boolean;
      reason?: string;
      maxNotional: number;
      price?: number;
      affordable1Share?: boolean;
      proxyCandidates?: string[];
      proxyChosen?: string | null;
      proxyAffordable1Share?: boolean;
    }
  >;
  flags: DataQualityFlag[];
  executionCapabilities: { fractionalShares: boolean; minExecutableNotionalUSD: number };
} => {
  const flags: DataQualityFlag[] = [];
  const eligibility: Record<
    string,
    {
      tradable: boolean;
      reason?: string;
      maxNotional: number;
      price?: number;
      affordable1Share?: boolean;
      proxyCandidates?: string[];
      proxyChosen?: string | null;
      proxyAffordable1Share?: boolean;
    }
  > = {};
  const minExec = config.minExecutableNotionalUSD ?? 1;
  const fractional = config.fractionalSharesSupported ?? true;
  for (const f of features) {
    const hasData = f.return20d !== undefined && f.return60d !== undefined;
    const maxNotional = portfolioEquity * config.maxPositionPct;
    const price = f.price;
    const affordable1Share = price !== undefined ? maxNotional >= price : undefined;
    const proxyCandidates = proxies[f.symbol] || [];
    const proxyChosen = proxyCandidates.length ? proxyCandidates[0] : null;
    const proxyFeature = proxyChosen ? features.find((x) => x.symbol === proxyChosen) : undefined;
    const proxyPrice = proxyFeature?.price;
    const proxyAffordable = proxyPrice !== undefined ? maxNotional >= proxyPrice : undefined;
    if (!hasData) {
      eligibility[f.symbol] = {
        tradable: false,
        reason: 'insufficient history',
        maxNotional,
        price,
        affordable1Share,
        proxyCandidates,
        proxyChosen,
        proxyAffordable1Share: proxyAffordable
      };
    } else if (maxNotional < minExec) {
      eligibility[f.symbol] = {
        tradable: false,
        reason: 'below_min_notional',
        maxNotional,
        price,
        affordable1Share,
        proxyCandidates,
        proxyChosen,
        proxyAffordable1Share: proxyAffordable
      };
      flags.push({
        code: 'MIN_NOTIONAL_NOT_MET',
        severity: 'warn',
        message: `${f.symbol} max notional ${maxNotional.toFixed(2)} below executable minimum ${minExec}`,
        symbols: [f.symbol],
        observed: { maxNotional, minExecutableNotionalUSD: minExec },
        action: 'warn'
      });
    } else {
      eligibility[f.symbol] = {
        tradable: true,
        maxNotional,
        price,
        affordable1Share,
        proxyCandidates,
        proxyChosen,
        proxyAffordable1Share: proxyAffordable
      };
      if (affordable1Share === false && proxyAffordable) {
        flags.push({
          code: 'WHOLE_SHARE_CONSTRAINT_PRESENT',
          severity: 'info',
          message: `${f.symbol} unaffordable as 1 share; proxy ${proxyChosen} affordable`,
          symbols: [f.symbol],
          observed: { maxNotional, price, proxy: proxyChosen, proxyPrice }
        });
      }
    }
    if (!hasData)
      flags.push({
        code: 'ELIGIBILITY_BLOCKED',
        severity: 'warn',
        message: `Eligibility blocked for ${f.symbol}`,
        symbols: [f.symbol],
        action: 'warn'
      });
  }
  return { eligibility, flags, executionCapabilities: { fractionalShares: fractional, minExecutableNotionalUSD: minExec } };
};

const buildNews = async () => {
  const client = getFinnhubClient();
  if (!client) return [];
  try {
    return await client.getLatestNews(6);
  } catch {
    return [];
  }
};

const deterministicMemo = (regimes: RegimeContext, flags: DataQualityFlag[], asOf: string): Record<string, unknown> => {
  const dominant = regimes.equityRegime?.label ?? regimes.risk ?? 'neutral';
  const flagMessages = flags.map((f) => `${f.severity}: ${f.message}`);
  const lowEquityConf = flags.some((f) => f.code === 'LOW_EQUITY_CONFIDENCE');
  const bullets = [
    `Regime: ${dominant}`,
    regimes.ratesRegime ? `Rates ${regimes.ratesRegime.label} (${regimes.ratesRegime.stance ?? 'neutral'})` : null,
    regimes.volRegime ? `Vol ${regimes.volRegime.label}` : null
  ].filter(Boolean);
  return {
    asOf,
    memo: {
      dominant_regime: dominant,
      bullets,
      key_risks: [
        regimes.equityRegime?.transitionRisk === 'elevated' ? 'Equity regime transition risk elevated' : null,
        lowEquityConf ? 'Equity regime confidence low' : null
      ].filter(Boolean),
      watch_items: [regimes.ratesRegime ? `Rates ${regimes.ratesRegime.label}` : null].filter(Boolean)
    },
    data_quality_notes: flagMessages
  };
};

const enforceSize = (packet: Omit<LLMContextPacket, 'contextMeta'>): { ctx: LLMContextPacket; meta: ContextMeta } => {
  const meta: ContextMeta = { maxBytes: MAX_CONTEXT_BYTES, sizeBytes: 0, truncated: false, dropped: [] };
  let working: any = { ...packet };
  const measure = () => JSON.stringify(working).length;
  let size = measure();
  if (size > MAX_CONTEXT_BYTES && working.news) {
    delete working.news;
    meta.dropped?.push?.('news');
    size = measure();
  }
  if (size > MAX_CONTEXT_BYTES && working.features && working.features.length > 10) {
    working.features = working.features.slice(0, 10);
    meta.dropped?.push?.('features_tail');
    size = measure();
  }
  meta.sizeBytes = size;
  meta.truncated = size > MAX_CONTEXT_BYTES;
  const ctx: LLMContextPacket = { ...working, contextMeta: meta };
  return { ctx, meta };
};

export const generateBaseArtifacts = async (
  asOf: string,
  runId: string,
  config: BotConfig,
  universe: string[],
  marketData: MarketDataProvider,
  options: ContextOptions = {},
  brokerOverride?: ReturnType<typeof getBroker>
) => {
  const broker = brokerOverride ?? getBroker(config, marketData);
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const inputsPath = path.join(runDir, 'inputs.json');

  let portfolio;
  let quotes: Record<string, number>;
  let history: Record<string, PriceBar[]>;
  let fredSeries: MacroSeries[] | undefined;

  if (options.useExistingInputs && fs.existsSync(inputsPath)) {
    const existing = JSON.parse(fs.readFileSync(inputsPath, 'utf-8')) as RunInputs;
    portfolio = existing.portfolio;
    quotes = existing.quotes;
    history = existing.history || {};
    fredSeries = existing.macro;
  } else {
    let portfolioBroker = broker;
    const wantLivePortfolio =
      options.mode === 'paper' &&
      (process.env.USE_ETRADE_PORTFOLIO_IN_PAPER === 'true' || process.env.USE_LIVE_DATA_IN_PAPER === 'true') &&
      (process.env.BROKER_PROVIDER || '').toLowerCase() === 'etrade';
    if (wantLivePortfolio) {
      const status = getStatus();
      const consumerKey = process.env.ETRADE_CONSUMER_KEY;
      const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
      if (status.status !== 'ACTIVE' || !consumerKey || !consumerSecret) {
        throw new Error('E*TRADE auth inactive or keys missing; cannot read live portfolio.');
      }
      portfolioBroker = new ETradeBroker(
        config,
        marketData,
        new ETradeClient({
          consumerKey,
          consumerSecret,
          env: (process.env.ETRADE_ENV as any) || 'prod',
          callbackUrl: process.env.ETRADE_CALLBACK_URL,
          tokenStorePath: process.env.ETRADE_TOKEN_STORE || process.env.TOKEN_STORE_PATH
        })
      );
    }
    portfolio = await portfolioBroker.getPortfolioState(asOf);
    quotes = Object.fromEntries(
      await Promise.all(universe.map(async (u) => [u, (await marketData.getQuote(u, asOf)).price]))
    );
    const lookback = options.lookbackDays ?? HISTORY_LOOKBACK_DAYS;
    const historyEntries = await Promise.all(
      universe.map(async (u) => [u, await marketData.getHistory(u, asOf, lookback)] as const)
    );
    history = Object.fromEntries(historyEntries);
  }

  // We no longer honor ASSUME_CASH_OVERRIDE; always rely on live broker data.
  const overrideFlags: DataQualityFlag[] = [];
  if (process.env.ASSUME_CASH_OVERRIDE) {
    overrideFlags.push({
      code: 'PORTFOLIO_OVERRIDE_IGNORED',
      severity: 'warn',
      message: 'ASSUME_CASH_OVERRIDE is set but ignored; using broker portfolio instead.',
      action: 'warn'
    });
  }

  const inputs: RunInputs = {
    asOf,
    config,
    universe,
    portfolio,
    quotes,
    history
  };

  const seriesList: string[] = options.series ?? ['SP500', 'CPIAUCSL', 'UNRATE', 'DGS10', 'FEDFUNDS'];
  const fred = getFredClient();
  const fredSeriesRaw: MacroSeries[] = fredSeries ?? (await fred.getMacroSnapshot(seriesList));
  const fredSeriesTrimmed: MacroSeries[] = trimMacroSeries(fredSeriesRaw, asOf, MACRO_MONTHS_LIMIT);
  inputs.macro = fredSeriesTrimmed;

  const { flags: round0Flags, diagnostics: round0Diagnostics, summary: round0Summary } = evaluateRound0(
    asOf,
    universe,
    quotes,
    history,
    fredSeriesTrimmed,
    config,
    options.mode
  );

  const round1Flags: DataQualityFlag[] = [];
  const features = buildFeatures(universe, quotes, history, round1Flags);

  const proxiesMap: Record<string, string[]> = config.allowExecutionProxies
    ? safeLoadJson<Record<string, string[]>>(path.resolve(process.cwd(), config.proxiesFile || ''), {})
    : {};

  const round2 = buildRegimes(asOf, features, fredSeriesTrimmed, config);
  const { eligibility, flags: eligFlags, executionCapabilities } = buildEligibility(
    features,
    portfolio.equity,
    config,
    proxiesMap
  );
  const round2Flags = [...round2.flags, ...eligFlags];

  const round3Flags: DataQualityFlag[] = [];
  const macroPolicy = buildMacroPolicy(fredSeriesTrimmed, round3Flags);
  const news = await buildNews();
  if (!news.length)
    round3Flags.push({ code: 'NEWS_MISSING', severity: 'warn', message: 'No news fetched', action: 'warn' });
  const priorQualityFlags = [...round0Flags, ...round1Flags, ...round2Flags];
  if (priorQualityFlags.length) {
    round3Flags.push({
      code: 'ROUND3_DATA_QUALITY_PRESENT',
      severity: 'info',
      message: 'Data quality warnings present from prior rounds',
      observed: { counts: { round0: round0Flags.length, round1: round1Flags.length, round2: round2Flags.length } }
    });
  }
  const round3MemoFlags: DataQualityFlag[] = [];
  const memo = deterministicMemo(round2.regimes, [...priorQualityFlags, ...round3Flags], asOf);
  const validateMemo = (m: any): boolean =>
    m &&
    typeof m === 'object' &&
    m.asOf &&
    m.memo &&
    Array.isArray(m.memo.bullets) &&
    Array.isArray(m.memo.key_risks) &&
    Array.isArray(m.memo.watch_items);
  if (!validateMemo(memo)) {
    round3MemoFlags.push({
      code: 'ROUND3_MEMO_FALLBACK',
      severity: 'warn',
      message: 'Memo schema invalid; using deterministic fallback',
      action: 'warn'
    });
  }

  const dataQuality = {
    round0: round0Flags,
    round1: round1Flags,
    round2: round2Flags,
    round3: [...round3Flags, ...round3MemoFlags]
  };

  const slimNews = news.map((n: any) => ({
    headline: n.headline,
    source: n.source,
    datetime: n.datetime
  }));
  const packetBase: Omit<LLMContextPacket, 'contextMeta'> = {
    asOf,
    runId,
    universe,
    portfolio,
    quotes,
    features,
    macro: undefined,
    regimes: round2.regimes,
    macroPolicy,
    news: slimNews,
    marketMemo: memo,
    dataQuality,
    constraints: {
      maxPositions: config.maxPositions,
      maxTradesPerRun: config.maxTradesPerRun,
      maxPositionPct: config.maxPositionPct,
      minCashPct: config.minCashPct,
      maxNotionalTradedPctPerRun: config.maxNotionalTradedPctPerRun,
      minHoldHours: config.minHoldHours,
      maxWeeklyDrawdownPct: config.maxWeeklyDrawdownPct,
      cadence: config.cadence
    },
    generatedAt: new Date().toISOString(),
    eligibility,
    executionCapabilities
  };
  const rawContains = { macro: fredSeriesTrimmed.length > 0, news: news.length > 0 };
  const { ctx, meta } = enforceSize(packetBase);
  meta.stage = 'ROUND_4';
  const ctxHash = require('crypto').createHash('sha256').update(JSON.stringify(ctx)).digest('hex');
  meta.lineage = { round4Hash: ctxHash };
  meta.sources = {
    marketDataProvider: (process.env.MARKET_DATA_PROVIDER || 'stub').toLowerCase(),
    macroProvider: process.env.FRED_API_KEY ? 'fred' : 'stub',
    newsProvider: process.env.FINNHUB_API_KEY ? 'finnhub' : 'none',
    macroWindowMonths: MACRO_MONTHS_LIMIT
  };
  meta.rawContains = rawContains;
  meta.payloadContains = { macro: Boolean(ctx.macro ?? rawContains.macro), news: Boolean(ctx.news ?? rawContains.news) };
  inputs.contextMeta = meta;

  ensureDir(runDir);
  writeJSONFile(path.join(runDir, 'inputs.json'), inputs);
  writeJSONFile(path.join(runDir, 'context.json'), ctx);
  writeJSONFile(path.join(runDir, 'llm_context.json'), ctx);
  writeJSONFile(path.join(runDir, 'context_meta.json'), meta);
  writeJSONFile(path.join(runDir, 'round0_diagnostics.json'), round0Diagnostics);
  writeJSONFile(path.join(runDir, 'round0_summary.json'), round0Summary);
  writeJSONFile(path.join(runDir, 'round0_flags.json'), round0Flags);
  writeJSONFile(path.join(runDir, 'features.json'), features);
  writeJSONFile(path.join(runDir, 'round1_flags.json'), round1Flags);
  writeJSONFile(path.join(runDir, 'regimes.json'), round2.regimes);
  writeJSONFile(path.join(runDir, 'eligibility.json'), eligibility);
  writeJSONFile(path.join(runDir, 'round2_flags.json'), round2Flags);
  writeJSONFile(path.join(runDir, 'news_headlines.json'), news);
  writeJSONFile(path.join(runDir, 'macro_policy.json'), macroPolicy);
  writeJSONFile(path.join(runDir, 'market_memo.json'), memo);
  writeJSONFile(path.join(runDir, 'round3_flags.json'), [...round3Flags, ...round3MemoFlags]);
  const contextPath = writeContextPacket(runId, ctx);

  return { inputs, packet: ctx, contextPath };
};

export const ensureBaseArtifacts = async (
  asOf: string,
  runId: string,
  configPath: string,
  seriesList?: string[],
  mode: string = 'paper'
): Promise<RunInputs> => {
  const cfg: BotConfig = loadConfig(configPath);
  const universe = loadUniverse(path.resolve(process.cwd(), cfg.universeFile));
  const marketData = getMarketDataProvider(mode as any);
  const broker = getBroker(cfg, marketData, mode as any);
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const inputsPath = path.join(runDir, 'inputs.json');
  if (fs.existsSync(inputsPath)) {
    return JSON.parse(fs.readFileSync(inputsPath, 'utf-8')) as RunInputs;
  }
  const { inputs } = await generateBaseArtifacts(asOf, runId, cfg, universe, marketData, { series: seriesList, mode }, broker);
  return inputs;
};

// Round-specific builders that consume existing artifacts

export const buildRound1FromInputs = async (runId: string) => {
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const inputs: RunInputs = JSON.parse(fs.readFileSync(path.join(runDir, 'inputs.json'), 'utf-8'));
  const round1Flags: DataQualityFlag[] = [];
  const features = buildFeatures(inputs.universe, inputs.quotes, inputs.history || {}, round1Flags);
  writeJSONFile(path.join(runDir, 'features.json'), features);
  writeJSONFile(path.join(runDir, 'round1_flags.json'), round1Flags);
};

export const buildRound2FromFeatures = async (runId: string) => {
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const inputs: RunInputs = JSON.parse(fs.readFileSync(path.join(runDir, 'inputs.json'), 'utf-8'));
  const features: SymbolFeature[] = JSON.parse(fs.readFileSync(path.join(runDir, 'features.json'), 'utf-8'));
  const round1Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round1_flags.json'), 'utf-8'));
  const round2 = buildRegimes(inputs.asOf, features, inputs.macro || [], inputs.config as BotConfig);
  const proxiesMap: Record<string, string[]> =
    (inputs.config as BotConfig).allowExecutionProxies && (inputs.config as BotConfig).proxiesFile
      ? safeLoadJson<Record<string, string[]>>(
          path.resolve(process.cwd(), (inputs.config as BotConfig).proxiesFile || ''),
          {}
        )
      : {};
  const { eligibility, flags: eligFlags, executionCapabilities } = buildEligibility(
    features,
    inputs.portfolio.equity,
    inputs.config,
    proxiesMap
  );
  const round2Flags = [...round2.flags, ...eligFlags, ...round1Flags.filter((f) => f.action === 'block')];
  writeJSONFile(path.join(runDir, 'regimes.json'), round2.regimes);
  writeJSONFile(path.join(runDir, 'eligibility.json'), { eligibility, executionCapabilities });
  writeJSONFile(path.join(runDir, 'round2_flags.json'), round2Flags);
};

export const buildRound3FromRegimes = async (runId: string) => {
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const inputs: RunInputs = JSON.parse(fs.readFileSync(path.join(runDir, 'inputs.json'), 'utf-8'));
  const regimes: RegimeContext = JSON.parse(fs.readFileSync(path.join(runDir, 'regimes.json'), 'utf-8'));
  const round3Flags: DataQualityFlag[] = [];
  const macroPolicy = buildMacroPolicy(inputs.macro || [], round3Flags);
  let news = [];
  const existingNewsPath = path.join(runDir, 'news_headlines.json');
  if (fs.existsSync(existingNewsPath)) {
    news = JSON.parse(fs.readFileSync(existingNewsPath, 'utf-8'));
  } else {
    news = await buildNews();
  }
  if (!news.length)
    round3Flags.push({ code: 'NEWS_MISSING', severity: 'warn', message: 'No news fetched', action: 'warn' });
  const round0Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round0_flags.json'), 'utf-8'));
  const round1Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round1_flags.json'), 'utf-8'));
  const round2Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round2_flags.json'), 'utf-8'));
  const priorQualityFlags = [...round0Flags, ...round1Flags, ...round2Flags];
  if (priorQualityFlags.length) {
    round3Flags.push({
      code: 'ROUND3_DATA_QUALITY_PRESENT',
      severity: 'info',
      message: 'Data quality warnings present from prior rounds',
      observed: { counts: { round0: round0Flags.length, round1: round1Flags.length, round2: round2Flags.length } }
    });
  }
  const memo = deterministicMemo(regimes, [...priorQualityFlags, ...round3Flags], inputs.asOf);
  const memoFlags: DataQualityFlag[] = [];
  const validateMemo = (m: any): boolean =>
    m &&
    typeof m === 'object' &&
    m.asOf &&
    m.memo &&
    Array.isArray(m.memo.bullets) &&
    Array.isArray(m.memo.key_risks) &&
    Array.isArray(m.memo.watch_items);
  if (!validateMemo(memo)) {
    memoFlags.push({
      code: 'ROUND3_MEMO_FALLBACK',
      severity: 'warn',
      message: 'Memo schema invalid; using deterministic fallback',
      action: 'warn'
    });
  }
  writeJSONFile(path.join(runDir, 'macro_policy.json'), macroPolicy);
  writeJSONFile(path.join(runDir, 'news_headlines.json'), news);
  writeJSONFile(path.join(runDir, 'market_memo.json'), memo);
  writeJSONFile(path.join(runDir, 'round3_flags.json'), [...round3Flags, ...memoFlags]);
};

export const buildRound4Context = async (runId: string) => {
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const inputs: RunInputs = JSON.parse(fs.readFileSync(path.join(runDir, 'inputs.json'), 'utf-8'));
  const features: SymbolFeature[] = JSON.parse(fs.readFileSync(path.join(runDir, 'features.json'), 'utf-8'));
  const regimes: RegimeContext = JSON.parse(fs.readFileSync(path.join(runDir, 'regimes.json'), 'utf-8'));
  const macroPolicy = JSON.parse(fs.readFileSync(path.join(runDir, 'macro_policy.json'), 'utf-8'));
  const news = JSON.parse(fs.readFileSync(path.join(runDir, 'news_headlines.json'), 'utf-8'));
  const memo = JSON.parse(fs.readFileSync(path.join(runDir, 'market_memo.json'), 'utf-8'));
  const round0Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round0_flags.json'), 'utf-8'));
  const round1Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round1_flags.json'), 'utf-8'));
  const round2Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round2_flags.json'), 'utf-8'));
  const round3Flags: DataQualityFlag[] = JSON.parse(fs.readFileSync(path.join(runDir, 'round3_flags.json'), 'utf-8'));
  const eligibility = JSON.parse(fs.readFileSync(path.join(runDir, 'eligibility.json'), 'utf-8'));
  const dataQuality = {
    round0: round0Flags,
    round1: round1Flags,
    round2: round2Flags,
    round3: round3Flags
  };
  const packetBase: Omit<LLMContextPacket, 'contextMeta'> = {
    asOf: inputs.asOf,
    runId,
    universe: inputs.universe,
    portfolio: inputs.portfolio,
    quotes: inputs.quotes,
    features,
    macro: inputs.macro,
    regimes,
    macroPolicy,
    news,
    marketMemo: memo,
    dataQuality,
    constraints: {
      maxPositions: inputs.config.maxPositions,
      maxTradesPerRun: inputs.config.maxTradesPerRun,
      maxPositionPct: inputs.config.maxPositionPct,
      minCashPct: inputs.config.minCashPct,
      maxNotionalTradedPctPerRun: inputs.config.maxNotionalTradedPctPerRun,
      minHoldHours: inputs.config.minHoldHours,
      maxWeeklyDrawdownPct: inputs.config.maxWeeklyDrawdownPct,
      cadence: inputs.config.cadence
    },
    generatedAt: new Date().toISOString(),
    eligibility
  };
  const rawContains = { macro: Boolean(inputs.macro), news: Boolean(news.length) };
  const { ctx, meta } = enforceSize(packetBase);
  meta.sources = {
    marketDataProvider: (process.env.MARKET_DATA_PROVIDER || 'stub').toLowerCase(),
    macroProvider: process.env.FRED_API_KEY ? 'fred' : 'stub',
    newsProvider: process.env.FINNHUB_API_KEY ? 'finnhub' : 'none',
    macroWindowMonths: MACRO_MONTHS_LIMIT
  };
  meta.rawContains = rawContains;
  meta.payloadContains = { macro: Boolean(ctx.macro ?? rawContains.macro), news: Boolean(ctx.news ?? rawContains.news) };
  writeJSONFile(path.join(runDir, 'llm_context.json'), ctx);
  writeJSONFile(path.join(runDir, 'context.json'), ctx);
  writeJSONFile(path.join(runDir, 'context_meta.json'), meta);
  writeContextPacket(runId, ctx);
};
