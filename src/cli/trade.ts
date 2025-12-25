import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { parseAsOfDateTime } from '../core/time';
import { runBot } from './run';
import { preflightAuth } from '../broker/etrade/authService';
import { generateBaseArtifacts } from './contextBuilder';
import { loadConfig, loadUniverse } from '../core/utils';
import { getMarketDataProvider } from '../data/marketData';
import { getBroker } from '../broker/broker';

const program = new Command();

program
  .option('--asof <dateTime>', 'as-of timestamp (YYYY-MM-DD or YYYY-MM-DDTHH:mm, UTC)')
  .option('--mode <mode>', 'paper | live | backtest', 'paper')
  .option('--strategy <strategy>', 'llm | deterministic | random')
  .option('--dry-run', 'simulate without placing orders', false)
  .option('--auto-exec', 'override approval gate and execute immediately', false)
  .option('--force', 'override idempotency', false);

const run = async () => {
  const opts = program.parse(process.argv).opts();
  const { asOf, runId } = parseAsOfDateTime(opts.asof);
  const auth = preflightAuth(opts.mode);
  if (!auth.allow) {
    throw new Error(auth.warning || 'Auth not active');
  } else if (auth.warning) {
    console.warn(auth.warning);
  }
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const llmContextPath = path.join(runDir, 'llm_context.json');
  if (!fs.existsSync(llmContextPath)) {
    const config = loadConfig(path.resolve(process.cwd(), 'src/config/default.json'));
    const universe = loadUniverse(path.resolve(process.cwd(), config.universeFile));
    const md = getMarketDataProvider(opts.mode);
    const broker = getBroker(config, md, opts.mode);
    await generateBaseArtifacts(asOf, runId, config, universe, md, {}, broker);
  }
  await runBot({
    asof: asOf,
    mode: opts.mode,
    strategy: opts.strategy,
    dryRun: opts.dryRun,
    force: opts.force,
    autoExec: opts.autoExec
  });
};

if (require.main === module) {
  run().catch((err) => {
    console.error('bot:trade failed', err);
    process.exitCode = 1;
  });
}
