import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import type { HistoricalReplayInput } from '../src/replay/runHistoricalReplay';
import type { HistoricalReplayBar } from '../src/replay/historicalMarketData';

type ExternalBarRow = {
  symbol: string;
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  adjustedClose?: number;
  volume?: number;
};

type ProxyMetadata = {
  bundleType: 'proxy_based_non_canonical';
  approximate: true;
  windowStart: string;
  windowEnd: string;
  preRollBars: number;
  calendarSymbol: string;
  assumptions: string[];
  proxiedSymbols: Array<{
    symbol: string;
    proxyKind: 'rebased_real_proxy' | 'synthetic_weighted_returns';
    proxySource: string;
    proxyStartDate: string;
    proxyEndDate: string;
    cutoverDate: string;
    notes: string;
  }>;
};

const TARGET_UNIVERSE = ['VTI', 'VXUS', 'VTV', 'USMV', 'SHY', 'IEF', 'TIP'] as const;
const VXUS_PROXY_SYMBOL = 'VEU';
const USMV_SYNTH_EQUITY_SYMBOL = 'VTV';
const USMV_SYNTH_DEFENSIVE_SYMBOL = 'SHY';
const USMV_EQUITY_WEIGHT = 0.75;
const USMV_DEFENSIVE_WEIGHT = 0.25;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const program = new Command();

program
  .requiredOption('--input <path>', 'Path to normalized external JSON bars')
  .requiredOption('--output <path>', 'Path to output HistoricalReplayInput JSON')
  .requiredOption('--window-start <date>', 'Replay window start date in YYYY-MM-DD')
  .requiredOption('--window-end <date>', 'Replay window end date in YYYY-MM-DD')
  .requiredOption('--pre-roll-bars <count>', 'Number of bars to include before the replay window start', (value) => Number(value))
  .option('--metadata-output <path>', 'Optional path to write proxy metadata JSON')
  .option('--calendar-symbol <symbol>', 'Replay calendar symbol', 'VTI')
  .option('--bar-frequency <freq>', 'Replay bar frequency: 1d or 1w', '1w');

const asDateValue = (value: string) => new Date(`${value}T00:00:00Z`).getTime();

const assertDate = (value: string, label: string) => {
  if (!DATE_RE.test(value) || Number.isNaN(asDateValue(value))) {
    throw new Error(`${label} must be YYYY-MM-DD. Received: ${value}`);
  }
};

const readRows = (inputPath: string): ExternalBarRow[] => {
  const resolved = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input file not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as unknown;
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('Input JSON must be a non-empty array of bar rows.');
  }
  return parsed as ExternalBarRow[];
};

const normalizeRow = (row: ExternalBarRow, index: number): { symbol: string; bar: HistoricalReplayBar } => {
  if (!row || typeof row !== 'object') {
    throw new Error(`Row ${index} is not an object.`);
  }
  if (!row.symbol || typeof row.symbol !== 'string') {
    throw new Error(`Row ${index} is missing required field "symbol".`);
  }
  if (!row.date || typeof row.date !== 'string') {
    throw new Error(`Row ${index} is missing required field "date".`);
  }
  assertDate(row.date, `Row ${index} date`);

  const chosenClose = row.adjustedClose ?? row.close;
  if (typeof chosenClose !== 'number' || !Number.isFinite(chosenClose) || chosenClose <= 0) {
    throw new Error(`Row ${index} must include a positive numeric "adjustedClose" or "close".`);
  }

  const maybeNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

  return {
    symbol: row.symbol.trim().toUpperCase(),
    bar: {
      date: row.date,
      open: maybeNumber(row.open),
      high: maybeNumber(row.high),
      low: maybeNumber(row.low),
      close: chosenClose
    }
  };
};

const sortBars = (bars: HistoricalReplayBar[]) =>
  [...bars].sort((a, b) => asDateValue(a.date) - asDateValue(b.date));

const dedupeBars = (bars: HistoricalReplayBar[]) => {
  const deduped: HistoricalReplayBar[] = [];
  for (const bar of sortBars(bars)) {
    if (!deduped.length || deduped[deduped.length - 1].date !== bar.date) {
      deduped.push(bar);
    } else {
      deduped[deduped.length - 1] = bar;
    }
  }
  return deduped;
};

const scaleBars = (bars: HistoricalReplayBar[], factor: number) =>
  bars.map((bar) => ({
    ...bar,
    close: Number((bar.close * factor).toFixed(8)),
    ...(bar.open !== undefined ? { open: Number((bar.open * factor).toFixed(8)) } : {}),
    ...(bar.high !== undefined ? { high: Number((bar.high * factor).toFixed(8)) } : {}),
    ...(bar.low !== undefined ? { low: Number((bar.low * factor).toFixed(8)) } : {})
  }));

const buildSyntheticReturnSeries = (
  equityBars: HistoricalReplayBar[],
  defensiveBars: HistoricalReplayBar[]
): HistoricalReplayBar[] => {
  const equityByDate = new Map(equityBars.map((bar) => [bar.date, bar]));
  const defensiveByDate = new Map(defensiveBars.map((bar) => [bar.date, bar]));
  const commonDates = equityBars
    .map((bar) => bar.date)
    .filter((date) => defensiveByDate.has(date))
    .sort((a, b) => asDateValue(a) - asDateValue(b));

  if (commonDates.length < 2) {
    throw new Error(
      `Synthetic USMV proxy requires overlapping ${USMV_SYNTH_EQUITY_SYMBOL}/${USMV_SYNTH_DEFENSIVE_SYMBOL} history on at least two dates.`
    );
  }

  const synthetic: HistoricalReplayBar[] = [{ date: commonDates[0], close: 100 }];
  let currentClose = 100;
  for (let i = 1; i < commonDates.length; i += 1) {
    const date = commonDates[i];
    const prevDate = commonDates[i - 1];
    const prevEquity = equityByDate.get(prevDate)!;
    const nextEquity = equityByDate.get(date)!;
    const prevDefensive = defensiveByDate.get(prevDate)!;
    const nextDefensive = defensiveByDate.get(date)!;

    const equityReturn = nextEquity.close / prevEquity.close - 1;
    const defensiveReturn = nextDefensive.close / prevDefensive.close - 1;
    const blendedReturn = equityReturn * USMV_EQUITY_WEIGHT + defensiveReturn * USMV_DEFENSIVE_WEIGHT;
    currentClose *= 1 + blendedReturn;
    synthetic.push({ date, close: Number(currentClose.toFixed(8)) });
  }

  return synthetic;
};

const stitchWithCutover = (proxyBars: HistoricalReplayBar[], realBars: HistoricalReplayBar[], symbol: string) => {
  if (!realBars.length) {
    throw new Error(`No real history available to cut over into ${symbol}.`);
  }

  const cutoverDate = realBars[0].date;
  const proxySegment = proxyBars.filter((bar) => bar.date < cutoverDate);
  if (!proxySegment.length) {
    return {
      bars: realBars,
      metadata: null
    };
  }

  const scaleFactor = realBars[0].close / proxySegment[proxySegment.length - 1].close;
  const stitched = [...scaleBars(proxySegment, scaleFactor), ...realBars];
  return {
    bars: stitched,
    metadata: {
      proxyStartDate: proxySegment[0].date,
      proxyEndDate: proxySegment[proxySegment.length - 1].date,
      cutoverDate
    }
  };
};

const sliceWithPreRoll = (bars: HistoricalReplayBar[], symbol: string, windowStart: string, windowEnd: string, preRollBars: number) => {
  const startIndex = bars.findIndex((bar) => bar.date >= windowStart);
  if (startIndex < 0) {
    throw new Error(`Requested window start is not covered for ${symbol}.`);
  }
  const endIndex = (() => {
    for (let i = bars.length - 1; i >= 0; i -= 1) {
      if (bars[i].date <= windowEnd) return i;
    }
    return -1;
  })();
  if (endIndex < startIndex) {
    throw new Error(`Requested window end is not covered for ${symbol}.`);
  }
  const sliceStartIndex = Math.max(0, startIndex - preRollBars);
  if (sliceStartIndex === startIndex) {
    throw new Error(`Lead-in history is missing for ${symbol}.`);
  }
  return bars.slice(sliceStartIndex, endIndex + 1);
};

const main = () => {
  const opts = program.parse(process.argv).opts<{
    input: string;
    output: string;
    metadataOutput?: string;
    windowStart: string;
    windowEnd: string;
    preRollBars: number;
    calendarSymbol: string;
    barFrequency: '1d' | '1w';
  }>();

  assertDate(opts.windowStart, 'window-start');
  assertDate(opts.windowEnd, 'window-end');
  if (asDateValue(opts.windowEnd) < asDateValue(opts.windowStart)) {
    throw new Error('window-end must be on or after window-start.');
  }
  if (!Number.isInteger(opts.preRollBars) || opts.preRollBars <= 0) {
    throw new Error('pre-roll-bars must be a positive integer.');
  }
  if (!['1d', '1w'].includes(opts.barFrequency)) {
    throw new Error('bar-frequency must be either 1d or 1w.');
  }

  const rows = readRows(opts.input).map(normalizeRow);
  const grouped = new Map<string, HistoricalReplayBar[]>();
  rows.forEach(({ symbol, bar }) => {
    const existing = grouped.get(symbol) || [];
    existing.push(bar);
    grouped.set(symbol, existing);
  });

  if (!grouped.size) {
    throw new Error('No symbol series could be built from the provided rows.');
  }

  const requiredInputs = ['VTI', 'VTV', 'SHY', 'IEF', 'TIP', VXUS_PROXY_SYMBOL, 'VXUS', 'USMV'];
  requiredInputs.forEach((symbol) => {
    if (!grouped.has(symbol)) {
      throw new Error(`Missing required source symbol for proxy bundle construction: ${symbol}`);
    }
  });

  const seriesBySymbol = Object.fromEntries(Array.from(grouped.entries()).map(([symbol, bars]) => [symbol, dedupeBars(bars)]));

  const passthroughSymbols = ['VTI', 'VTV', 'SHY', 'IEF', 'TIP'];
  const outputSeries: Record<string, HistoricalReplayBar[]> = {};

  passthroughSymbols.forEach((symbol) => {
    outputSeries[symbol] = sliceWithPreRoll(seriesBySymbol[symbol], symbol, opts.windowStart, opts.windowEnd, opts.preRollBars);
  });

  const vxusRealBars = seriesBySymbol.VXUS.filter((bar) => bar.date <= opts.windowEnd);
  const vxusProxyBars = seriesBySymbol[VXUS_PROXY_SYMBOL].filter((bar) => bar.date <= opts.windowEnd);
  const vxusStitched = stitchWithCutover(vxusProxyBars, vxusRealBars, 'VXUS');
  outputSeries.VXUS = sliceWithPreRoll(vxusStitched.bars, 'VXUS', opts.windowStart, opts.windowEnd, opts.preRollBars);

  const usmvRealBars = seriesBySymbol.USMV.filter((bar) => bar.date <= opts.windowEnd);
  const usmvSyntheticBars = buildSyntheticReturnSeries(seriesBySymbol[USMV_SYNTH_EQUITY_SYMBOL], seriesBySymbol[USMV_SYNTH_DEFENSIVE_SYMBOL]).filter(
    (bar) => bar.date <= opts.windowEnd
  );
  const usmvStitched = stitchWithCutover(usmvSyntheticBars, usmvRealBars, 'USMV');
  outputSeries.USMV = sliceWithPreRoll(usmvStitched.bars, 'USMV', opts.windowStart, opts.windowEnd, opts.preRollBars);

  const replayInput: HistoricalReplayInput = {
    series: outputSeries,
    dateRange: {
      start: opts.windowStart,
      end: opts.windowEnd
    },
    barFrequency: opts.barFrequency,
    preRollBars: opts.preRollBars,
    calendarSymbol: opts.calendarSymbol.trim().toUpperCase(),
    universe: [...TARGET_UNIVERSE]
  };

  const metadata: ProxyMetadata = {
    bundleType: 'proxy_based_non_canonical',
    approximate: true,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    preRollBars: opts.preRollBars,
    calendarSymbol: replayInput.calendarSymbol || 'VTI',
    assumptions: [
      'External input must be a JSON array of normalized bars with symbol, date, and adjustedClose or close.',
      'adjustedClose is preferred; close is assumed adjusted when adjustedClose is absent.',
      `VXUS uses rebased ${VXUS_PROXY_SYMBOL} history until the first available real VXUS bar, then switches to real VXUS.`,
      `USMV uses a synthetic return series of ${USMV_EQUITY_WEIGHT * 100}% ${USMV_SYNTH_EQUITY_SYMBOL} and ${USMV_DEFENSIVE_WEIGHT * 100}% ${USMV_SYNTH_DEFENSIVE_SYMBOL} until the first available real USMV bar, then switches to real USMV.`
    ],
    proxiedSymbols: [
      {
        symbol: 'VXUS',
        proxyKind: 'rebased_real_proxy',
        proxySource: VXUS_PROXY_SYMBOL,
        proxyStartDate: vxusStitched.metadata?.proxyStartDate || vxusRealBars[0]?.date || '',
        proxyEndDate: vxusStitched.metadata?.proxyEndDate || vxusRealBars[0]?.date || '',
        cutoverDate: vxusStitched.metadata?.cutoverDate || vxusRealBars[0]?.date || '',
        notes: `${VXUS_PROXY_SYMBOL} closes are scaled to match the first real VXUS close at cutover.`
      },
      {
        symbol: 'USMV',
        proxyKind: 'synthetic_weighted_returns',
        proxySource: `${USMV_EQUITY_WEIGHT * 100}% ${USMV_SYNTH_EQUITY_SYMBOL} + ${USMV_DEFENSIVE_WEIGHT * 100}% ${USMV_SYNTH_DEFENSIVE_SYMBOL}`,
        proxyStartDate: usmvStitched.metadata?.proxyStartDate || usmvRealBars[0]?.date || '',
        proxyEndDate: usmvStitched.metadata?.proxyEndDate || usmvRealBars[0]?.date || '',
        cutoverDate: usmvStitched.metadata?.cutoverDate || usmvRealBars[0]?.date || '',
        notes: 'Synthetic series is built from weighted weekly returns, then rebased to match the first real USMV close at cutover.'
      }
    ]
  };

  const outputPath = path.resolve(process.cwd(), opts.output);
  const metadataPath = path.resolve(
    process.cwd(),
    opts.metadataOutput || `${opts.output.replace(/\.json$/i, '')}.metadata.json`
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(replayInput, null, 2));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  console.log(`Proxy historical replay bundle written to ${outputPath}`);
  console.log(`Proxy metadata written to ${metadataPath}`);
  console.log(`Window: ${opts.windowStart} -> ${opts.windowEnd}`);
  console.log(`Universe: ${TARGET_UNIVERSE.join(', ')}`);
  console.log(`VXUS proxy: ${VXUS_PROXY_SYMBOL} until ${metadata.proxiedSymbols[0].cutoverDate}`);
  console.log(
    `USMV proxy: ${metadata.proxiedSymbols[1].proxySource} until ${metadata.proxiedSymbols[1].cutoverDate}`
  );
};

main();
