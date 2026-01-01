import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { parseAsOfDateTime } from '../core/time';
import { loadConfig, loadUniverse, ensureDir } from '../core/utils';
import { getMarketDataProvider } from '../data/marketData';
import { getBroker } from '../broker/broker';
import { generateBaseArtifacts } from './contextBuilder';
import { preflightAuth } from '../broker/etrade/authService';

const program = new Command();

program.option('--asof <dateTime>', 'as-of timestamp (YYYY-MM-DD or YYYY-MM-DDTHH:mm, UTC)').option(
  '--series <ids>',
  'Comma-separated FRED series IDs',
  'SP500,CPIAUCSL,UNRATE,DGS10'
);
program.option('--mode <mode>', 'paper | live', 'paper');

const run = async () => {
  const opts = program.parse(process.argv).opts();
  const { asOf, runId } = parseAsOfDateTime(opts.asof);
  const seriesList: string[] = String(opts.series || '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
  const auth = preflightAuth();
  if (auth.warning) {
    console.warn(auth.warning);
  }

  const configPath = path.resolve(process.cwd(), 'src/config/default.json');
  const config = loadConfig(configPath);
  const universe = loadUniverse(path.resolve(process.cwd(), config.universeFile));
  const marketData = getMarketDataProvider(opts.mode as any);
  const broker = getBroker(config, marketData, opts.mode as any);

  const runDir = path.resolve(process.cwd(), 'runs', runId);
  if (!fs.existsSync(runDir)) ensureDir(runDir);

  await generateBaseArtifacts(asOf, runId, config, universe, marketData, { series: seriesList, mode: opts.mode || 'paper' }, broker);
  console.log(`Dump completed for ${runId}. Artifacts in runs/${runId} and context/${runId}.json`);
};

run().catch((err) => {
  console.error('bot:dump failed', err);
  process.exitCode = 1;
});
