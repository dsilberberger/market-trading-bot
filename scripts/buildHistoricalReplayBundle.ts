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

const program = new Command();

program
  .requiredOption('--input <path>', 'Path to normalized external JSON bars')
  .requiredOption('--output <path>', 'Path to output HistoricalReplayInput JSON')
  .requiredOption('--window-start <date>', 'Replay window start date in YYYY-MM-DD')
  .requiredOption('--window-end <date>', 'Replay window end date in YYYY-MM-DD')
  .option('--lead-in-start <date>', 'First date to include before the replay window in YYYY-MM-DD')
  .option('--pre-roll-bars <count>', 'Number of bars to include before the replay window start', (value) => Number(value))
  .option('--symbols <list>', 'Comma-separated required symbol list')
  .option('--calendar-symbol <symbol>', 'Optional replay calendar symbol')
  .option('--bar-frequency <freq>', 'Replay bar frequency: 1d or 1w', '1w');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  // Assumption: adjustedClose should be used when supplied; otherwise close is assumed adjusted.
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

const unique = <T>(values: T[]) => [...new Set(values)];

const main = () => {
  const opts = program.parse(process.argv).opts<{
    input: string;
    output: string;
    windowStart: string;
    windowEnd: string;
    leadInStart?: string;
    preRollBars?: number;
    symbols?: string;
    calendarSymbol?: string;
    barFrequency: '1d' | '1w';
  }>();

  assertDate(opts.windowStart, 'window-start');
  assertDate(opts.windowEnd, 'window-end');
  if (asDateValue(opts.windowEnd) < asDateValue(opts.windowStart)) {
    throw new Error('window-end must be on or after window-start.');
  }
  if (opts.leadInStart) {
    assertDate(opts.leadInStart, 'lead-in-start');
    if (asDateValue(opts.leadInStart) > asDateValue(opts.windowStart)) {
      throw new Error('lead-in-start must be on or before window-start.');
    }
  }
  if (opts.preRollBars !== undefined && (!Number.isInteger(opts.preRollBars) || opts.preRollBars < 0)) {
    throw new Error('pre-roll-bars must be a non-negative integer.');
  }
  if (!opts.leadInStart && (opts.preRollBars === undefined || opts.preRollBars === 0)) {
    throw new Error('Provide either --lead-in-start or a positive --pre-roll-bars value.');
  }
  if (!['1d', '1w'].includes(opts.barFrequency)) {
    throw new Error('bar-frequency must be either 1d or 1w.');
  }

  const requiredSymbols = unique(
    (opts.symbols || '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  );

  const rows = readRows(opts.input).map(normalizeRow);
  const grouped = new Map<string, HistoricalReplayBar[]>();
  rows.forEach(({ symbol, bar }) => {
    const bars = grouped.get(symbol) || [];
    bars.push(bar);
    grouped.set(symbol, bars);
  });

  if (!grouped.size) {
    throw new Error('No symbol series could be built from the provided rows.');
  }

  requiredSymbols.forEach((symbol) => {
    if (!grouped.has(symbol)) {
      throw new Error(`Missing required symbol series: ${symbol}`);
    }
  });

  const outputSeries: Record<string, HistoricalReplayBar[]> = {};
  const missingWindowCoverage: string[] = [];
  const missingLeadIn: string[] = [];
  const universe = requiredSymbols.length ? requiredSymbols : unique(Array.from(grouped.keys()).sort());

  universe.forEach((symbol) => {
    const sorted = sortBars(grouped.get(symbol) || []);
    const deduped: HistoricalReplayBar[] = [];
    for (const bar of sorted) {
      if (!deduped.length || deduped[deduped.length - 1].date !== bar.date) {
        deduped.push(bar);
      } else {
        deduped[deduped.length - 1] = bar;
      }
    }

    const startIndex = deduped.findIndex((bar) => bar.date >= opts.windowStart);
    const endIndex = (() => {
      for (let i = deduped.length - 1; i >= 0; i -= 1) {
        if (deduped[i].date <= opts.windowEnd) return i;
      }
      return -1;
    })();
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
      missingWindowCoverage.push(symbol);
      return;
    }

    let sliceStartIndex = startIndex;
    if (opts.leadInStart) {
      const leadInIndex = deduped.findIndex((bar) => bar.date >= opts.leadInStart!);
      if (leadInIndex < 0 || leadInIndex >= startIndex) {
        missingLeadIn.push(symbol);
        return;
      }
      sliceStartIndex = leadInIndex;
    } else if ((opts.preRollBars || 0) > 0) {
      sliceStartIndex = Math.max(0, startIndex - (opts.preRollBars || 0));
      if (sliceStartIndex === startIndex) {
        missingLeadIn.push(symbol);
        return;
      }
    }

    outputSeries[symbol] = deduped.slice(sliceStartIndex, endIndex + 1);
  });

  if (missingWindowCoverage.length) {
    throw new Error(`Requested window is not fully covered for symbols: ${missingWindowCoverage.join(', ')}`);
  }
  if (missingLeadIn.length) {
    throw new Error(`Lead-in history is missing for symbols: ${missingLeadIn.join(', ')}`);
  }
  if (!Object.keys(outputSeries).length) {
    throw new Error('No output series were produced after validation.');
  }

  const replayInput: HistoricalReplayInput = {
    series: outputSeries,
    dateRange: {
      start: opts.windowStart,
      end: opts.windowEnd
    },
    barFrequency: opts.barFrequency,
    universe,
    ...(opts.calendarSymbol ? { calendarSymbol: opts.calendarSymbol.trim().toUpperCase() } : {}),
    ...(opts.preRollBars && opts.preRollBars > 0 ? { preRollBars: opts.preRollBars } : {})
  };

  const outputPath = path.resolve(process.cwd(), opts.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(replayInput, null, 2));

  console.log(`Historical replay bundle written to ${outputPath}`);
  console.log(`Symbols: ${universe.join(', ')}`);
  console.log(`Window: ${opts.windowStart} -> ${opts.windowEnd}`);
  if (opts.leadInStart) {
    console.log(`Lead-in start: ${opts.leadInStart}`);
  } else if (opts.preRollBars) {
    console.log(`Pre-roll bars: ${opts.preRollBars}`);
  }
  console.log('Input format: JSON array of rows with symbol, date, and adjustedClose or close. Dates must be YYYY-MM-DD.');
};

main();
