import path from 'path';
import { loadConfig } from '../src/core/utils';
import { getMarketDataProvider } from '../src/data/marketData';
import { getBroker } from '../src/broker/broker';
import { runIdToAsOf } from '../src/core/time';
import { readRunArtifact, writeRunArtifact } from '../src/ledger/storage';
import { appendEvent, makeEvent } from '../src/ledger/ledger';
import { Fill, OrderPlacement } from '../src/core/types';

const args = process.argv.slice(2);
const runArg = args.find((a) => a === '--run' || a === '-r');
const runId = runArg ? args[args.indexOf(runArg) + 1] : args[0];

if (!runId) {
  console.error('Usage: ts-node scripts/syncFills.ts --run <runId>');
  process.exit(1);
}

const main = async () => {
  const config = loadConfig(path.resolve(process.cwd(), 'src/config/default.json'));
  const marketData = getMarketDataProvider('live' as any);
  const broker = getBroker(config, marketData, 'live');
  const asOf = runIdToAsOf(runId);
  const placements = readRunArtifact<OrderPlacement[]>(runId, 'placements.json') || [];
  if (!placements.length) {
    console.error(`No placements.json found for run ${runId}`);
    process.exit(1);
  }
  const orderIds = placements.map((p) => String(p.orderId));
  const fills: Fill[] = await broker.getFills(orderIds, asOf);
  writeRunArtifact(runId, 'fills.json', fills);
  for (const fill of fills) {
    appendEvent(makeEvent(runId, 'FILL_RECORDED', { fill }));
  }
  console.log(`Synced fills for ${runId}. Wrote ${fills.length} fills to fills.json`);
};

main().catch((err) => {
  console.error('syncFills error:', (err as Error).message);
  process.exit(1);
});
