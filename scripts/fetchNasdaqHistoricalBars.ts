import fs from 'fs';
import path from 'path';
import { Command } from 'commander';

type DailyBar = {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
};

type OutputRow = {
  symbol: string;
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
};

type WeeklyAnchor = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY';

type NasdaqHistoricalResponse = {
  data?: {
    symbol?: string;
    totalRecords?: number;
    tradesTable?: {
      rows?: Array<{
        date?: string;
        close?: string;
        open?: string;
        high?: string;
        low?: string;
        volume?: string;
      }> | null;
    };
  } | null;
  status?: {
    rCode?: number;
    bCodeMessage?: Array<{ errorMessage?: string }>;
  };
};

const program = new Command();

program
  .requiredOption('--symbols <list>', 'Comma-separated symbol list')
  .requiredOption('--fromdate <date>', 'First date to request in YYYY-MM-DD')
  .requiredOption('--output <path>', 'Path to output normalized JSON bars')
  .option('--metadata-output <path>', 'Optional path to write fetch metadata JSON')
  .option('--frequency <freq>', '1d or 1w', '1w')
  .option('--weekly-anchor <day>', 'MONDAY..FRIDAY anchor for weekly resampling', 'TUESDAY')
  .option('--page-size <count>', 'Nasdaq page size', (value) => Number(value), 500);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NASDAQ_BASE_URL = 'https://api.nasdaq.com/api/quote';
const WEEKDAY_TO_UTC: Record<WeeklyAnchor, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5
};

const assertDate = (value: string, label: string) => {
  if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error(`${label} must be YYYY-MM-DD. Received: ${value}`);
  }
};

const asDateValue = (value: string) => new Date(`${value}T00:00:00Z`).getTime();

const parseNumber = (value?: string): number | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, '').replace(/\$/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const toIsoDate = (value?: string): string => {
  if (!value) {
    throw new Error('Nasdaq row is missing date.');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) {
    const alt = new Date(`${value} UTC`);
    if (Number.isFinite(alt.getTime())) {
      return alt.toISOString().slice(0, 10);
    }
    throw new Error(`Unable to parse Nasdaq date: ${value}`);
  }
  return parsed.toISOString().slice(0, 10);
};

const readJson = async (url: string): Promise<NasdaqHistoricalResponse> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Nasdaq fetch failed ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as NasdaqHistoricalResponse;
};

const fetchSymbolDailyBars = async (symbol: string, fromdate: string, pageSize: number) => {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const firstPageUrl = `${NASDAQ_BASE_URL}/${encodeURIComponent(normalizedSymbol)}/historical?assetclass=etf&fromdate=${fromdate}&limit=${pageSize}`;
  const firstPage = await readJson(firstPageUrl);
  const pageErrors = firstPage.status?.bCodeMessage?.map((entry) => entry.errorMessage).filter(Boolean) || [];
  if (pageErrors.length) {
    throw new Error(`Nasdaq returned an error for ${normalizedSymbol}: ${pageErrors.join('; ')}`);
  }

  const totalRecords = firstPage.data?.totalRecords ?? 0;
  if (!totalRecords) {
    throw new Error(`No Nasdaq historical rows returned for ${normalizedSymbol} from ${fromdate}.`);
  }

  const rows: NonNullable<NonNullable<NasdaqHistoricalResponse['data']>['tradesTable']>['rows'] = [];
  for (let offset = 0; offset < totalRecords; offset += pageSize) {
    const url = `${NASDAQ_BASE_URL}/${encodeURIComponent(normalizedSymbol)}/historical?assetclass=etf&fromdate=${fromdate}&limit=${pageSize}&offset=${offset}`;
    const payload = offset === 0 ? firstPage : await readJson(url);
    const pageRows = payload.data?.tradesTable?.rows || [];
    if (!pageRows.length) {
      break;
    }
    rows.push(...pageRows);
    if (pageRows.length < pageSize) {
      break;
    }
  }

  const parsed: DailyBar[] = [];
  for (const row of rows) {
    const close = parseNumber(row?.close);
    if (!close || close <= 0) {
      continue;
    }
    parsed.push({
      date: toIsoDate(row?.date),
      close,
      open: parseNumber(row?.open),
      high: parseNumber(row?.high),
      low: parseNumber(row?.low),
      volume: parseNumber(row?.volume)
    });
  }
  parsed.sort((a, b) => asDateValue(a.date) - asDateValue(b.date));

  const deduped: DailyBar[] = [];
  for (const bar of parsed) {
    if (!deduped.length || deduped[deduped.length - 1].date !== bar.date) {
      deduped.push(bar);
    } else {
      deduped[deduped.length - 1] = bar;
    }
  }

  if (!deduped.length) {
    throw new Error(`No usable daily bars were parsed for ${normalizedSymbol}.`);
  }

  return {
    symbol: normalizedSymbol,
    bars: deduped,
    totalRecordsReported: totalRecords,
    firstDate: deduped[0].date,
    lastDate: deduped[deduped.length - 1].date
  };
};

const nextAnchorDate = (date: string, anchorDay: WeeklyAnchor) => {
  const utcAnchor = WEEKDAY_TO_UTC[anchorDay];
  const parsed = new Date(`${date}T00:00:00Z`);
  const currentDay = parsed.getUTCDay();
  const delta = (utcAnchor - currentDay + 7) % 7;
  const anchored = new Date(parsed.getTime() + delta * 24 * 60 * 60 * 1000);
  return anchored.toISOString().slice(0, 10);
};

const resampleWeekly = (bars: DailyBar[], anchorDay: WeeklyAnchor): DailyBar[] => {
  const weekly: DailyBar[] = [];
  let activeKey: string | null = null;
  let activeBars: DailyBar[] = [];

  const flush = () => {
    if (!activeBars.length) return;
    const first = activeBars[0];
    const last = activeBars[activeBars.length - 1];
    weekly.push({
      date: last.date,
      open: first.open ?? first.close,
      high: activeBars.reduce((max, bar) => Math.max(max, bar.high ?? bar.close), -Infinity),
      low: activeBars.reduce((min, bar) => Math.min(min, bar.low ?? bar.close), Infinity),
      close: last.close,
      volume: activeBars.reduce((sum, bar) => sum + (bar.volume ?? 0), 0)
    });
    activeBars = [];
  };

  for (const bar of bars) {
    const key = nextAnchorDate(bar.date, anchorDay);
    if (activeKey !== null && key !== activeKey) {
      flush();
    }
    activeKey = key;
    activeBars.push(bar);
  }
  flush();

  return weekly;
};

const toOutputRows = (symbol: string, bars: DailyBar[]): OutputRow[] =>
  bars.map((bar) => ({
    symbol,
    date: bar.date,
    ...(bar.open !== undefined ? { open: Number(bar.open.toFixed(8)) } : {}),
    ...(bar.high !== undefined ? { high: Number(bar.high.toFixed(8)) } : {}),
    ...(bar.low !== undefined ? { low: Number(bar.low.toFixed(8)) } : {}),
    close: Number(bar.close.toFixed(8)),
    ...(bar.volume !== undefined ? { volume: Math.round(bar.volume) } : {})
  }));

const main = async () => {
  const opts = program.parse(process.argv).opts<{
    symbols: string;
    fromdate: string;
    output: string;
    metadataOutput?: string;
    frequency: '1d' | '1w';
    weeklyAnchor: WeeklyAnchor;
    pageSize: number;
  }>();

  assertDate(opts.fromdate, 'fromdate');
  if (!['1d', '1w'].includes(opts.frequency)) {
    throw new Error(`frequency must be 1d or 1w. Received: ${opts.frequency}`);
  }
  if (!Number.isInteger(opts.pageSize) || opts.pageSize <= 0) {
    throw new Error(`page-size must be a positive integer. Received: ${opts.pageSize}`);
  }
  const weeklyAnchor = String(opts.weeklyAnchor || 'TUESDAY').trim().toUpperCase() as WeeklyAnchor;
  if (!(weeklyAnchor in WEEKDAY_TO_UTC)) {
    throw new Error(`weekly-anchor must be one of ${Object.keys(WEEKDAY_TO_UTC).join(', ')}. Received: ${opts.weeklyAnchor}`);
  }

  const symbols = Array.from(
    new Set(
      opts.symbols
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean)
    )
  );
  if (!symbols.length) {
    throw new Error('At least one symbol is required.');
  }

  const fetchResults = [];
  for (const symbol of symbols) {
    fetchResults.push(await fetchSymbolDailyBars(symbol, opts.fromdate, opts.pageSize));
  }

  const outputRows: OutputRow[] = [];
  const metadataSymbols = [];
  for (const result of fetchResults) {
    const transformed = opts.frequency === '1w' ? resampleWeekly(result.bars, weeklyAnchor) : result.bars;
    outputRows.push(...toOutputRows(result.symbol, transformed));
    metadataSymbols.push({
      symbol: result.symbol,
      source: 'nasdaq_quote_historical',
      adjusted: false,
      dailyRowsFetched: result.bars.length,
      outputRowsWritten: transformed.length,
      firstFetchedDate: result.firstDate,
      lastFetchedDate: result.lastDate
    });
  }

  outputRows.sort((a, b) => {
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
    return asDateValue(a.date) - asDateValue(b.date);
  });

  const outputPath = path.resolve(process.cwd(), opts.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(outputRows, null, 2));

  if (opts.metadataOutput) {
    const metadataPath = path.resolve(process.cwd(), opts.metadataOutput);
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          source: 'nasdaq_quote_historical',
          sourceUrlTemplate: `${NASDAQ_BASE_URL}/{symbol}/historical?assetclass=etf&fromdate=${opts.fromdate}&limit=${opts.pageSize}&offset={offset}`,
          fetchedAt: new Date().toISOString(),
          fromdate: opts.fromdate,
          outputFrequency: opts.frequency,
          weeklyAnchor: opts.frequency === '1w' ? weeklyAnchor : null,
          adjusted: false,
          note: 'Nasdaq historical quote API provided real external OHLC data, but not adjusted closes. close values are raw closes.',
          symbols: metadataSymbols
        },
        null,
        2
      )
    );
  }

  console.log(`Nasdaq historical bars written to ${outputPath}`);
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Frequency: ${opts.frequency}${opts.frequency === '1w' ? ` (${weeklyAnchor} anchor)` : ''}`);
  metadataSymbols.forEach((item) => {
    console.log(
      `${item.symbol}: fetched ${item.dailyRowsFetched} daily rows (${item.firstFetchedDate} -> ${item.lastFetchedDate}), wrote ${item.outputRowsWritten} ${opts.frequency} rows`
    );
  });
};

main().catch((error) => {
  console.error('fetchNasdaqHistoricalBars failed', error);
  process.exitCode = 1;
});
