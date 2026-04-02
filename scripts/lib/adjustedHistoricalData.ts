import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { HistoricalReplayInput } from '../../src/replay/runHistoricalReplay';
import type { HistoricalReplayBar } from '../../src/replay/historicalMarketData';

export type SupportedInterval = '1d' | '1wk';
export type SupportedSource = 'yahoo_chart';
export type SourceKind = 'direct' | 'proxy_rebased' | 'synthetic_weighted_returns';

export interface RawAdjustedBarRow {
  symbol: string;
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  adjustedClose: number;
  volume?: number;
}

export interface RawAdjustedSymbolMetadata {
  symbol: string;
  sourceSymbol: string;
  sourceName: SupportedSource;
  interval: SupportedInterval;
  rowCount: number;
  coverageStart: string;
  coverageEnd: string;
  dividendEventCount: number;
  splitEventCount: number;
}

export interface RawAdjustedMetadata {
  sourceName: SupportedSource;
  sourceUrlTemplate: string;
  fetchedAt: string;
  requestedSymbols: string[];
  symbolsFetched: string[];
  interval: SupportedInterval;
  requestDateRange: {
    start: string;
    end: string;
  };
  coverageStart: string;
  coverageEnd: string;
  symbolSubstitutions: Array<{
    requestedSymbol: string;
    sourceSymbol: string;
    reason: string;
  }>;
  symbols: RawAdjustedSymbolMetadata[];
  notes: string[];
}

export interface NormalizedAdjustedBarRow {
  symbol: string;
  date: string;
  close: number;
  adjustedClose: number;
  sourceSymbol: string;
  sourceKind: SourceKind;
}

export interface NormalizedAdjustedMetadata {
  sourceName: SupportedSource;
  interval: SupportedInterval;
  adjustedData: true;
  requestedSymbols: string[];
  actualSourceSymbols: string[];
  coverageStart: string;
  coverageEnd: string;
  substitutions: Array<{
    symbol: string;
    sourceKind: Exclude<SourceKind, 'direct'>;
    sourceSymbol: string;
    proxyStartDate: string;
    proxyEndDate: string;
    cutoverDate: string;
    approximate: boolean;
    notes: string;
  }>;
  symbols: Array<{
    symbol: string;
    rowCount: number;
    coverageStart: string;
    coverageEnd: string;
  }>;
  notes: string[];
}

export interface BundleMetadata {
  canonical: boolean;
  approximate: boolean;
  adjustedData: boolean;
  sourceName: SupportedSource;
  symbolsRequested: string[];
  symbolsActuallyUsed: string[];
  substitutionsUsed: Array<{
    symbol: string;
    sourceKind: Exclude<SourceKind, 'direct'>;
    sourceSymbol: string;
    proxyStartDate: string;
    proxyEndDate: string;
    cutoverDate: string;
    approximate: boolean;
    notes: string;
  }>;
  coverageStart: string;
  coverageEnd: string;
  windowStart: string;
  windowEnd: string;
  preRollBars: number;
  interval: SupportedInterval;
  notes: string[];
}

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      events?: {
        dividends?: Record<string, unknown>;
        splits?: Record<string, unknown>;
      };
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{
          adjclose?: Array<number | null>;
        }>;
      };
    }>;
    error?: {
      description?: string;
    } | null;
  };
};

const YAHOO_URL_TEMPLATE =
  'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={period1}&period2={period2}&interval={interval}&events=div%2Csplits&includeAdjustedClose=true';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const REPLAY_REQUESTED_SYMBOLS = ['VTI', 'VXUS', 'VTV', 'USMV', 'SHY', 'IEF', 'TIP'] as const;
export const ADJUSTED_FETCH_SYMBOLS = ['VTI', 'VXUS', 'VEU', 'VTV', 'USMV', 'SHY', 'IEF', 'TIP'] as const;
export const DEFAULT_PRE_ROLL_WEEKLY = 35;
const VXUS_PROXY_SYMBOL = 'VEU';
const USMV_SYNTH_SOURCE_SYMBOL = '75% VTV + 25% SHY';
const USMV_SYNTH_EQUITY_WEIGHT = 0.75;
const USMV_SYNTH_DEFENSIVE_WEIGHT = 0.25;

const asDateValue = (value: string) => new Date(`${value}T00:00:00Z`).getTime();

export const assertDate = (value: string, label: string) => {
  if (!DATE_RE.test(value) || Number.isNaN(asDateValue(value))) {
    throw new Error(`${label} must be YYYY-MM-DD. Received: ${value}`);
  }
};

const unique = <T>(values: T[]) => [...new Set(values)];

const round = (value: number) => Number(value.toFixed(8));

const parseJsonFromCurl = (url: string) => {
  const result = spawnSync('curl', ['-sS', '-H', 'User-Agent: Mozilla/5.0', url], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `curl failed with status ${result.status}`);
  }
  return JSON.parse(result.stdout) as YahooChartResponse;
};

const toUnixSeconds = (date: string, endExclusive = false) => {
  const base = new Date(`${date}T00:00:00Z`).getTime();
  const shifted = endExclusive ? base + 24 * 60 * 60 * 1000 : base;
  return Math.floor(shifted / 1000);
};

const dedupeRows = <T extends { date: string }>(rows: T[]) => {
  const deduped: T[] = [];
  for (const row of [...rows].sort((a, b) => asDateValue(a.date) - asDateValue(b.date))) {
    if (!deduped.length || deduped[deduped.length - 1].date !== row.date) {
      deduped.push(row);
    } else {
      deduped[deduped.length - 1] = row;
    }
  }
  return deduped;
};

const coverage = <T extends { date: string }>(rows: T[]) => {
  if (!rows.length) {
    return { start: '', end: '' };
  }
  let min = rows[0].date;
  let max = rows[0].date;
  rows.forEach((row) => {
    if (asDateValue(row.date) < asDateValue(min)) min = row.date;
    if (asDateValue(row.date) > asDateValue(max)) max = row.date;
  });
  return { start: min, end: max };
};

const makeDirectRows = (symbol: string, rows: RawAdjustedBarRow[]): NormalizedAdjustedBarRow[] =>
  rows.map((row) => ({
    symbol,
    date: row.date,
    close: row.close,
    adjustedClose: row.adjustedClose,
    sourceSymbol: symbol,
    sourceKind: 'direct'
  }));

const scaleNormalizedRows = (
  rows: NormalizedAdjustedBarRow[],
  symbol: string,
  sourceSymbol: string,
  sourceKind: Exclude<SourceKind, 'direct'>,
  closeScale: number,
  adjustedScale: number
): NormalizedAdjustedBarRow[] =>
  rows.map((row) => ({
    symbol,
    date: row.date,
    close: round(row.close * closeScale),
    adjustedClose: round(row.adjustedClose * adjustedScale),
    sourceSymbol,
    sourceKind
  }));

const stitchSeries = (
  symbol: string,
  proxyRows: NormalizedAdjustedBarRow[],
  realRows: NormalizedAdjustedBarRow[],
  sourceSymbol: string,
  sourceKind: Exclude<SourceKind, 'direct'>
) => {
  if (!realRows.length) {
    throw new Error(`No real history available to cut over into ${symbol}.`);
  }
  const cutoverDate = realRows[0].date;
  const proxySegment = proxyRows.filter((row) => row.date < cutoverDate);
  if (!proxySegment.length) {
    return {
      rows: realRows,
      substitution: null
    };
  }
  const lastProxy = proxySegment[proxySegment.length - 1];
  const firstReal = realRows[0];
  const closeScale = firstReal.close / lastProxy.close;
  const adjustedScale = firstReal.adjustedClose / lastProxy.adjustedClose;
  const scaledProxy = scaleNormalizedRows(proxySegment, symbol, sourceSymbol, sourceKind, closeScale, adjustedScale);
  return {
    rows: [...scaledProxy, ...realRows],
    substitution: {
      symbol,
      sourceKind,
      sourceSymbol,
      proxyStartDate: scaledProxy[0].date,
      proxyEndDate: scaledProxy[scaledProxy.length - 1].date,
      cutoverDate,
      approximate: true,
      notes:
        sourceKind === 'proxy_rebased'
          ? `${sourceSymbol} history is rebased to the first real ${symbol} close and adjusted close at cutover.`
          : `Synthetic adjusted-return history is rebased to the first real ${symbol} close and adjusted close at cutover.`
    }
  };
};

const buildSyntheticUsmvRows = (
  equityRows: RawAdjustedBarRow[],
  defensiveRows: RawAdjustedBarRow[]
): NormalizedAdjustedBarRow[] => {
  const equityByDate = new Map(equityRows.map((row) => [row.date, row]));
  const defensiveByDate = new Map(defensiveRows.map((row) => [row.date, row]));
  const commonDates = equityRows
    .map((row) => row.date)
    .filter((date) => defensiveByDate.has(date))
    .sort((a, b) => asDateValue(a) - asDateValue(b));
  if (commonDates.length < 2) {
    throw new Error('Synthetic USMV proxy requires overlapping VTV/SHY history on at least two dates.');
  }
  let current = 100;
  const synthetic: NormalizedAdjustedBarRow[] = [
    {
      symbol: 'USMV',
      date: commonDates[0],
      close: 100,
      adjustedClose: 100,
      sourceSymbol: USMV_SYNTH_SOURCE_SYMBOL,
      sourceKind: 'synthetic_weighted_returns'
    }
  ];
  for (let i = 1; i < commonDates.length; i += 1) {
    const prevDate = commonDates[i - 1];
    const date = commonDates[i];
    const prevEquity = equityByDate.get(prevDate)!;
    const nextEquity = equityByDate.get(date)!;
    const prevDefensive = defensiveByDate.get(prevDate)!;
    const nextDefensive = defensiveByDate.get(date)!;
    const equityReturn = nextEquity.adjustedClose / prevEquity.adjustedClose - 1;
    const defensiveReturn = nextDefensive.adjustedClose / prevDefensive.adjustedClose - 1;
    const blendedReturn = equityReturn * USMV_SYNTH_EQUITY_WEIGHT + defensiveReturn * USMV_SYNTH_DEFENSIVE_WEIGHT;
    current *= 1 + blendedReturn;
    synthetic.push({
      symbol: 'USMV',
      date,
      close: round(current),
      adjustedClose: round(current),
      sourceSymbol: USMV_SYNTH_SOURCE_SYMBOL,
      sourceKind: 'synthetic_weighted_returns'
    });
  }
  return synthetic;
};

export const fetchAdjustedBarsFromYahoo = (
  symbol: string,
  startDate: string,
  endDate: string,
  interval: SupportedInterval
) => {
  assertDate(startDate, 'startDate');
  assertDate(endDate, 'endDate');
  if (asDateValue(endDate) < asDateValue(startDate)) {
    throw new Error(`endDate must be on or after startDate for ${symbol}.`);
  }
  const url = YAHOO_URL_TEMPLATE.replace('{symbol}', encodeURIComponent(symbol))
    .replace('{period1}', String(toUnixSeconds(startDate)))
    .replace('{period2}', String(toUnixSeconds(endDate, true)))
    .replace('{interval}', interval);
  const payload = parseJsonFromCurl(url);
  if (payload.chart?.error) {
    throw new Error(payload.chart.error.description || `Yahoo chart error for ${symbol}`);
  }
  const result = payload.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart returned no result for ${symbol}.`);
  }
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  if (!quote || !timestamps.length) {
    throw new Error(`Yahoo chart returned no bars for ${symbol}.`);
  }

  const rows: RawAdjustedBarRow[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = quote.close?.[i];
    const adjustedClose = adj[i] ?? close;
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    if (typeof adjustedClose !== 'number' || !Number.isFinite(adjustedClose) || adjustedClose <= 0) {
      continue;
    }
    rows.push({
      symbol,
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      ...(typeof quote.open?.[i] === 'number' && Number.isFinite(quote.open[i]!)
        ? { open: round(quote.open[i] as number) }
        : {}),
      ...(typeof quote.high?.[i] === 'number' && Number.isFinite(quote.high[i]!)
        ? { high: round(quote.high[i] as number) }
        : {}),
      ...(typeof quote.low?.[i] === 'number' && Number.isFinite(quote.low[i]!)
        ? { low: round(quote.low[i] as number) }
        : {}),
      close: round(close),
      adjustedClose: round(adjustedClose),
      ...(typeof quote.volume?.[i] === 'number' && Number.isFinite(quote.volume[i]!)
        ? { volume: Math.round(quote.volume[i] as number) }
        : {})
    });
  }

  const deduped = dedupeRows(rows);
  if (!deduped.length) {
    throw new Error(`No usable Yahoo adjusted bars were parsed for ${symbol}.`);
  }
  const range = coverage(deduped);
  return {
    rows: deduped,
    metadata: {
      symbol,
      sourceSymbol: symbol,
      sourceName: 'yahoo_chart' as const,
      interval,
      rowCount: deduped.length,
      coverageStart: range.start,
      coverageEnd: range.end,
      dividendEventCount: Object.keys(result.events?.dividends || {}).length,
      splitEventCount: Object.keys(result.events?.splits || {}).length
    }
  };
};

export const fetchAdjustedBarsSet = (symbols: string[], startDate: string, endDate: string, interval: SupportedInterval) => {
  const dedupedSymbols = unique(
    symbols
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
      .sort()
  );
  const rows: RawAdjustedBarRow[] = [];
  const symbolMetadata: RawAdjustedSymbolMetadata[] = [];
  for (const symbol of dedupedSymbols) {
    const fetched = fetchAdjustedBarsFromYahoo(symbol, startDate, endDate, interval);
    rows.push(...fetched.rows);
    symbolMetadata.push(fetched.metadata);
  }
  rows.sort((a, b) => (a.symbol === b.symbol ? asDateValue(a.date) - asDateValue(b.date) : a.symbol.localeCompare(b.symbol)));
  const rowCoverage = coverage(rows);
  const metadata: RawAdjustedMetadata = {
    sourceName: 'yahoo_chart',
    sourceUrlTemplate: YAHOO_URL_TEMPLATE,
    fetchedAt: new Date().toISOString(),
    requestedSymbols: dedupedSymbols,
    symbolsFetched: dedupedSymbols,
    interval,
    requestDateRange: {
      start: startDate,
      end: endDate
    },
    coverageStart: rowCoverage.start,
    coverageEnd: rowCoverage.end,
    symbolSubstitutions: [],
    symbols: symbolMetadata,
    notes: [
      'Yahoo chart data includes raw close and adjusted close. Adjusted close is preserved explicitly for replay-ready bundle construction.',
      'Open/high/low values are source OHLC values and remain raw source fields in the raw bars artifact.'
    ]
  };
  return { rows, metadata };
};

export const readJsonFile = <T>(filePath: string): T => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8')) as T;

export const writeJsonFile = (filePath: string, data: unknown) => {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2));
};

export const buildNormalizedAdjustedSeries = (rows: RawAdjustedBarRow[], interval: SupportedInterval = '1wk') => {
  const grouped = new Map<string, RawAdjustedBarRow[]>();
  rows.forEach((row) => {
    const symbol = row.symbol.trim().toUpperCase();
    const existing = grouped.get(symbol) || [];
    existing.push(row);
    grouped.set(symbol, existing);
  });
  const getSeries = (symbol: string) => {
    const series = dedupeRows(grouped.get(symbol) || []);
    if (!series.length) {
      throw new Error(`Missing source history for ${symbol}.`);
    }
    return series;
  };

  const normalizedBySymbol: Record<string, NormalizedAdjustedBarRow[]> = {
    VTI: makeDirectRows('VTI', getSeries('VTI')),
    VTV: makeDirectRows('VTV', getSeries('VTV')),
    SHY: makeDirectRows('SHY', getSeries('SHY')),
    IEF: makeDirectRows('IEF', getSeries('IEF')),
    TIP: makeDirectRows('TIP', getSeries('TIP'))
  };

  const vxusDirect = makeDirectRows('VXUS', getSeries('VXUS'));
  const veuProxy = makeDirectRows('VXUS', getSeries(VXUS_PROXY_SYMBOL)).map((row) => ({
    ...row,
    sourceSymbol: VXUS_PROXY_SYMBOL,
    sourceKind: 'proxy_rebased' as const
  }));
  const stitchedVxus = stitchSeries('VXUS', veuProxy, vxusDirect, VXUS_PROXY_SYMBOL, 'proxy_rebased');
  normalizedBySymbol.VXUS = stitchedVxus.rows;

  const usmvDirect = makeDirectRows('USMV', getSeries('USMV'));
  const syntheticUsmv = buildSyntheticUsmvRows(getSeries('VTV'), getSeries('SHY'));
  const stitchedUsmv = stitchSeries('USMV', syntheticUsmv, usmvDirect, USMV_SYNTH_SOURCE_SYMBOL, 'synthetic_weighted_returns');
  normalizedBySymbol.USMV = stitchedUsmv.rows;

  const normalizedRows = Object.values(normalizedBySymbol)
    .flat()
    .sort((a, b) => (a.symbol === b.symbol ? asDateValue(a.date) - asDateValue(b.date) : a.symbol.localeCompare(b.symbol)));
  const normalizedCoverage = coverage(normalizedRows);
  const substitutions = [stitchedVxus.substitution, stitchedUsmv.substitution].filter(Boolean) as NormalizedAdjustedMetadata['substitutions'];
  const metadata: NormalizedAdjustedMetadata = {
    sourceName: 'yahoo_chart',
    interval,
    adjustedData: true,
    requestedSymbols: [...REPLAY_REQUESTED_SYMBOLS],
    actualSourceSymbols: unique(normalizedRows.map((row) => row.sourceSymbol)).sort(),
    coverageStart: normalizedCoverage.start,
    coverageEnd: normalizedCoverage.end,
    substitutions,
    symbols: [...REPLAY_REQUESTED_SYMBOLS].map((symbol) => {
      const series = normalizedRows.filter((row) => row.symbol === symbol);
      const range = coverage(series);
      return {
        symbol,
        rowCount: series.length,
        coverageStart: range.start,
        coverageEnd: range.end
      };
    }),
    notes: [
      'Normalized rows preserve raw close and adjusted close for direct symbols.',
      'VXUS uses rebased adjusted VEU history before the first real VXUS bar.',
      'USMV uses a synthetic adjusted-return history from 75% VTV and 25% SHY before the first real USMV bar.'
    ]
  };
  return { rows: normalizedRows, metadata };
};

const chooseReplayClose = (row: NormalizedAdjustedBarRow) => row.adjustedClose ?? row.close;

export const buildReplayBundleFromNormalizedRows = (
  rows: NormalizedAdjustedBarRow[],
  options: {
    windowStart: string;
    windowEnd: string;
    preRollBars: number;
    barFrequency: '1d' | '1w';
    calendarSymbol: string;
    universe?: string[];
  }
) => {
  assertDate(options.windowStart, 'windowStart');
  assertDate(options.windowEnd, 'windowEnd');
  if (options.preRollBars < 0 || !Number.isInteger(options.preRollBars)) {
    throw new Error(`preRollBars must be a non-negative integer. Received: ${options.preRollBars}`);
  }
  const universe = options.universe?.length ? options.universe : [...REPLAY_REQUESTED_SYMBOLS];
  const grouped = new Map<string, NormalizedAdjustedBarRow[]>();
  rows.forEach((row) => {
    const existing = grouped.get(row.symbol) || [];
    existing.push(row);
    grouped.set(row.symbol, existing);
  });

  const replaySeries: Record<string, HistoricalReplayBar[]> = {};
  const substitutionsUsedBySymbol = new Map<string, BundleMetadata['substitutionsUsed'][number]>();
  const actualSourceSymbols = new Set<string>();

  universe.forEach((symbol) => {
    const series = dedupeRows(grouped.get(symbol) || []);
    if (!series.length) {
      throw new Error(`Missing normalized series for ${symbol}.`);
    }
    const startIndex = series.findIndex((row) => row.date >= options.windowStart);
    const endIndex = (() => {
      for (let i = series.length - 1; i >= 0; i -= 1) {
        if (series[i].date <= options.windowEnd) return i;
      }
      return -1;
    })();
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
      throw new Error(`Requested window is not fully covered for ${symbol}.`);
    }
    const sliceStartIndex = Math.max(0, startIndex - options.preRollBars);
    if (sliceStartIndex === startIndex && options.preRollBars > 0) {
      throw new Error(`Lead-in history is missing for ${symbol}.`);
    }
    const slice = series.slice(sliceStartIndex, endIndex + 1);
    replaySeries[symbol] = slice.map((row) => ({
      date: row.date,
      close: chooseReplayClose(row)
    }));
    slice.forEach((row) => {
      actualSourceSymbols.add(row.sourceSymbol);
      if (row.sourceKind !== 'direct' && !substitutionsUsedBySymbol.has(symbol)) {
        const proxyRows = slice.filter((candidate) => candidate.sourceKind === row.sourceKind);
        substitutionsUsedBySymbol.set(symbol, {
          symbol,
          sourceKind: row.sourceKind,
          sourceSymbol: row.sourceSymbol,
          proxyStartDate: proxyRows[0].date,
          proxyEndDate: proxyRows[proxyRows.length - 1].date,
          cutoverDate: slice.find((candidate) => candidate.sourceKind === 'direct')?.date || proxyRows[proxyRows.length - 1].date,
          approximate: true,
          notes:
            row.sourceKind === 'proxy_rebased'
              ? `${row.sourceSymbol} history is rebased into ${symbol} until the first real ${symbol} bar in the bundle.`
              : `Synthetic weighted-return history is used for ${symbol} until the first real ${symbol} bar in the bundle.`
        });
      }
    });
  });

  const bundle: HistoricalReplayInput = {
    series: replaySeries,
    dateRange: {
      start: options.windowStart,
      end: options.windowEnd
    },
    barFrequency: options.barFrequency,
    preRollBars: options.preRollBars,
    calendarSymbol: options.calendarSymbol,
    universe
  };

  const allBundleBars = Object.values(replaySeries).flat();
  const bundleCoverage = coverage(allBundleBars);
  const substitutionsUsed = [...substitutionsUsedBySymbol.values()];
  const metadata: BundleMetadata = {
    canonical: substitutionsUsed.length === 0,
    approximate: substitutionsUsed.length > 0,
    adjustedData: true,
    sourceName: 'yahoo_chart',
    symbolsRequested: [...universe],
    symbolsActuallyUsed: [...actualSourceSymbols].sort(),
    substitutionsUsed,
    coverageStart: bundleCoverage.start,
    coverageEnd: bundleCoverage.end,
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    preRollBars: options.preRollBars,
    interval: options.barFrequency === '1w' ? '1wk' : '1d',
    notes: substitutionsUsed.length
      ? [
          'Bundle uses adjusted close for replay quotes and history.',
          'Bundle is approximate because it includes explicit proxy/synthetic history for missing pre-inception symbols.'
        ]
      : ['Bundle uses real adjusted close history with no proxy stitching inside the included series.']
  };

  return { bundle, metadata };
};

export const resolvePresetWindow = (preset?: string) => {
  if (!preset) return null;
  if (preset === '2010-2015') {
    return {
      windowStart: '2010-01-01',
      windowEnd: '2015-12-31',
      fetchStart: '2009-01-01',
      label: '2010-2015'
    };
  }
  if (preset === '1998-2003') {
    return {
      windowStart: '1998-01-01',
      windowEnd: '2003-12-31',
      fetchStart: '1997-01-01',
      label: '1998-2003'
    };
  }
  throw new Error(`Unsupported window preset: ${preset}`);
};
