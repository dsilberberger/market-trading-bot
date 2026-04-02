import { Command } from 'commander';
import {
  ADJUSTED_FETCH_SYMBOLS,
  DEFAULT_PRE_ROLL_WEEKLY,
  REPLAY_REQUESTED_SYMBOLS,
  assertDate,
  buildNormalizedAdjustedSeries,
  buildReplayBundleFromNormalizedRows,
  fetchAdjustedBarsSet,
  readJsonFile,
  resolvePresetWindow,
  type RawAdjustedBarRow,
  type SupportedInterval,
  writeJsonFile
} from './lib/adjustedHistoricalData';

const program = new Command();

program
  .option('--window <preset>', 'Window preset: 2010-2015 or 1998-2003')
  .option('--window-start <date>', 'Replay window start date in YYYY-MM-DD')
  .option('--window-end <date>', 'Replay window end date in YYYY-MM-DD')
  .option('--fetch-start <date>', 'Fetch start date in YYYY-MM-DD')
  .option('--raw-input <path>', 'Optional existing raw adjusted bar JSON input')
  .option('--raw-output <path>', 'Path to raw adjusted bar JSON output')
  .option('--raw-metadata-output <path>', 'Path to raw metadata JSON output')
  .option('--normalized-output <path>', 'Path to normalized adjusted bar JSON output')
  .option('--normalized-metadata-output <path>', 'Path to normalized metadata JSON output')
  .option('--bundle-output <path>', 'Path to replay bundle JSON output')
  .option('--bundle-metadata-output <path>', 'Path to replay bundle metadata JSON output')
  .option('--interval <interval>', 'Replay/source interval: 1d or 1wk', '1wk')
  .option('--pre-roll-bars <count>', 'Number of pre-roll bars to include', (value) => Number(value), DEFAULT_PRE_ROLL_WEEKLY)
  .option('--calendar-symbol <symbol>', 'Replay calendar symbol', 'VTI');

const makeDefaultPaths = (fetchStart: string, windowStart: string, windowEnd: string, interval: SupportedInterval) => {
  const suffix = interval === '1wk' ? 'weekly' : 'daily';
  const rawBase = `research/broad_validation/raw_bars/yahoo_adjusted_universe_${fetchStart}_${windowEnd}_${suffix}`;
  const normalizedBase = `research/broad_validation/normalized_bars/yahoo_adjusted_requested_${windowStart}_${windowEnd}_${suffix}`;
  const bundleBase = `research/broad_validation/bundles/yahoo_adjusted_${windowStart}_${windowEnd}_${suffix}`;
  return {
    rawOutput: `${rawBase}.json`,
    rawMetadataOutput: `${rawBase}.metadata.json`,
    normalizedOutput: `${normalizedBase}.json`,
    normalizedMetadataOutput: `${normalizedBase}.metadata.json`,
    bundleOutput: `${bundleBase}.json`,
    bundleMetadataOutput: `${bundleBase}.metadata.json`
  };
};

const main = () => {
  const opts = program.parse(process.argv).opts<{
    window?: string;
    windowStart?: string;
    windowEnd?: string;
    fetchStart?: string;
    rawInput?: string;
    rawOutput?: string;
    rawMetadataOutput?: string;
    normalizedOutput?: string;
    normalizedMetadataOutput?: string;
    bundleOutput?: string;
    bundleMetadataOutput?: string;
    interval: SupportedInterval;
    preRollBars: number;
    calendarSymbol: string;
  }>();

  if (!['1d', '1wk'].includes(opts.interval)) {
    throw new Error(`interval must be 1d or 1wk. Received: ${opts.interval}`);
  }
  if (!Number.isInteger(opts.preRollBars) || opts.preRollBars < 0) {
    throw new Error(`pre-roll-bars must be a non-negative integer. Received: ${opts.preRollBars}`);
  }

  const preset = resolvePresetWindow(opts.window);
  const windowStart = opts.windowStart || preset?.windowStart;
  const windowEnd = opts.windowEnd || preset?.windowEnd;
  const fetchStart = opts.fetchStart || preset?.fetchStart || windowStart;
  if (!windowStart || !windowEnd || !fetchStart) {
    throw new Error('Provide either --window 2010-2015 or explicit --window-start/--window-end/--fetch-start values.');
  }

  assertDate(windowStart, 'window-start');
  assertDate(windowEnd, 'window-end');
  assertDate(fetchStart, 'fetch-start');

  const defaults = makeDefaultPaths(fetchStart, windowStart, windowEnd, opts.interval);
  const rawOutput = opts.rawOutput || defaults.rawOutput;
  const rawMetadataOutput = opts.rawMetadataOutput || defaults.rawMetadataOutput;
  const normalizedOutput = opts.normalizedOutput || defaults.normalizedOutput;
  const normalizedMetadataOutput = opts.normalizedMetadataOutput || defaults.normalizedMetadataOutput;
  const bundleOutput = opts.bundleOutput || defaults.bundleOutput;
  const bundleMetadataOutput = opts.bundleMetadataOutput || defaults.bundleMetadataOutput;

  const rawRows = (() => {
    if (opts.rawInput) {
      return readJsonFile<RawAdjustedBarRow[]>(opts.rawInput);
    }
    const fetched = fetchAdjustedBarsSet([...ADJUSTED_FETCH_SYMBOLS], fetchStart, windowEnd, opts.interval);
    writeJsonFile(rawOutput, fetched.rows);
    writeJsonFile(rawMetadataOutput, {
      ...fetched.metadata,
      symbolSubstitutions: [
        {
          requestedSymbol: 'VXUS',
          sourceSymbol: 'VEU',
          reason: 'Needed as an explicit pre-inception real proxy for early VXUS history.'
        },
        {
          requestedSymbol: 'USMV',
          sourceSymbol: '75% VTV + 25% SHY',
          reason: 'Needed as an explicit synthetic weighted-return fallback before USMV inception.'
        }
      ]
    });
    return fetched.rows;
  })();

  const normalized = buildNormalizedAdjustedSeries(rawRows, opts.interval);
  writeJsonFile(normalizedOutput, normalized.rows);
  writeJsonFile(normalizedMetadataOutput, normalized.metadata);

  const { bundle, metadata } = buildReplayBundleFromNormalizedRows(normalized.rows, {
    windowStart,
    windowEnd,
    preRollBars: opts.preRollBars,
    barFrequency: opts.interval === '1wk' ? '1w' : '1d',
    calendarSymbol: opts.calendarSymbol.trim().toUpperCase(),
    universe: [...REPLAY_REQUESTED_SYMBOLS]
  });
  writeJsonFile(bundleOutput, bundle);
  writeJsonFile(bundleMetadataOutput, metadata);

  console.log(`Adjusted replay bundle written to ${bundleOutput}`);
  console.log(`Adjusted replay bundle metadata written to ${bundleMetadataOutput}`);
  console.log(`Normalized adjusted bars written to ${normalizedOutput}`);
  if (!opts.rawInput) {
    console.log(`Raw adjusted bars written to ${rawOutput}`);
  }
  console.log(`Window: ${windowStart} -> ${windowEnd}`);
  console.log(`Canonical: ${metadata.canonical}`);
  console.log(`Approximate: ${metadata.approximate}`);
};

main();
