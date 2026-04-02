import { Command } from 'commander';
import { assertDate, fetchAdjustedBarsSet, type SupportedInterval, writeJsonFile } from './lib/adjustedHistoricalData';

const program = new Command();

program
  .requiredOption('--symbols <list>', 'Comma-separated symbol list')
  .requiredOption('--fromdate <date>', 'First date to request in YYYY-MM-DD')
  .requiredOption('--todate <date>', 'Last date to request in YYYY-MM-DD')
  .requiredOption('--output <path>', 'Path to output raw adjusted bar JSON')
  .option('--metadata-output <path>', 'Optional path to output metadata JSON')
  .option('--interval <interval>', 'Yahoo chart interval: 1d or 1wk', '1wk');

const main = () => {
  const opts = program.parse(process.argv).opts<{
    symbols: string;
    fromdate: string;
    todate: string;
    output: string;
    metadataOutput?: string;
    interval: SupportedInterval;
  }>();

  assertDate(opts.fromdate, 'fromdate');
  assertDate(opts.todate, 'todate');
  if (!['1d', '1wk'].includes(opts.interval)) {
    throw new Error(`interval must be 1d or 1wk. Received: ${opts.interval}`);
  }

  const symbols = opts.symbols
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) {
    throw new Error('At least one symbol is required.');
  }

  const { rows, metadata } = fetchAdjustedBarsSet(symbols, opts.fromdate, opts.todate, opts.interval);
  writeJsonFile(opts.output, rows);
  if (opts.metadataOutput) {
    writeJsonFile(opts.metadataOutput, metadata);
  }

  console.log(`Adjusted historical bars written to ${opts.output}`);
  if (opts.metadataOutput) {
    console.log(`Adjusted historical bar metadata written to ${opts.metadataOutput}`);
  }
  console.log(`Symbols: ${metadata.symbolsFetched.join(', ')}`);
  console.log(`Window: ${opts.fromdate} -> ${opts.todate}`);
  console.log(`Interval: ${opts.interval}`);
};

main();
