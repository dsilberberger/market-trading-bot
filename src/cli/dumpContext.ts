import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { parseAsOfDateTime } from '../core/time';
import { ensureDir, loadConfig, loadUniverse, writeJSONFile } from '../core/utils';
import { getMarketDataProvider } from '../data/marketData';
import { getBroker } from '../broker/broker';
import { FredClient, writeContextPacket } from '../integrations/fredClient';

const program = new Command();

program.option('--asof <dateTime>', 'as-of timestamp (YYYY-MM-DD or YYYY-MM-DDTHH:mm, UTC)').option(
  '--series <ids>',
  'Comma-separated FRED series IDs',
  'SP500,CPIAUCSL,UNRATE,DGS10'
);

const runDump = async () => {
  const opts = program.parse(process.argv).opts();
  const { asOf, runId } = parseAsOfDateTime(opts.asof);
  const seriesList: string[] = String(opts.series || '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  const configPath = path.resolve(process.cwd(), 'src/config/default.json');
  const config = loadConfig(configPath);
  const universe = loadUniverse(path.resolve(process.cwd(), config.universeFile));
  const marketData = getMarketDataProvider();
  const broker = getBroker(config, marketData);

  const portfolio = await broker.getPortfolioState(asOf);
  const quotes = Object.fromEntries(await Promise.all(universe.map(async (u) => [u, (await marketData.getQuote(u, asOf)).price])));
  const fredKey = process.env.FRED_API_KEY;
  const fred = new FredClient(fredKey);
  const fredSeries = await fred.getMacroSnapshot(seriesList);

  const packet = {
    asOf,
    runId,
    config,
    universe,
    portfolio,
    quotes,
    macro: fredSeries,
    generatedAt: new Date().toISOString()
  };

  const contextPath = writeContextPacket(runId, packet);
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  if (fs.existsSync(runDir)) {
    writeJSONFile(path.join(runDir, 'context.json'), packet);
  }
  console.log(`Context packet written to ${contextPath}`);
};

runDump().catch((err) => {
  console.error('Context dump failed', err);
  process.exitCode = 1;
});
