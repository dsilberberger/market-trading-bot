import path from 'path';
import { loadConfig } from '../src/core/utils';
import { getMarketDataProvider } from '../src/data/marketData';
import { getBroker } from '../src/broker/broker';
import { executeOrders } from '../src/execution/executionEngine';
import { TradeOrder } from '../src/core/types';

(async () => {
  const config = loadConfig(path.resolve(process.cwd(), 'src/config/default.json'));
  const marketData = getMarketDataProvider('live' as any);
  const broker = getBroker(config, marketData, 'live' as any);
  const asOf = new Date().toISOString();
  const runId = `live-test-${asOf.replace(/[:.]/g, '-')}`;
  const order: TradeOrder = {
    symbol: 'IWM', // lower-priced than SPY/QQQ, adjust if needed
    side: 'BUY',
    orderType: 'MARKET',
    notionalUSD: 10, // aim to buy roughly one share if price <= $10; adjust symbol as needed
    thesis: 'Live connectivity test low-priced ETF',
    invalidation: 'Test only',
    confidence: 0.5,
    portfolioLevel: { targetHoldDays: 1, netExposureTarget: 0.1 }
  };
  const result = await executeOrders(runId, asOf, [order], broker, config, {
    dryRun: false,
    mode: 'live',
    brokerProvider: (process.env.BROKER_PROVIDER || 'stub').toLowerCase()
  });
  console.log(JSON.stringify({ runId, fills: result.fills }, null, 2));
})();
