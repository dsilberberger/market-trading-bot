import { runRandomBaseline } from '../src/strategy/randomBaseline';
import { runDeterministicBaseline } from '../src/strategy/deterministicBaseline';
import { StubMarketDataProvider } from '../src/data/marketData.stub';
import { BotConfig, PortfolioState } from '../src/core/types';

const config: BotConfig = {
  startingCapitalUSD: 250,
  maxPositions: 4,
  rebalanceDay: 'FRIDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.35,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0.05,
  maxNotionalTradedPctPerRun: 0.5,
  minHoldHours: 72,
  cadence: 'weekly',
  universeFile: 'src/config/universe.json',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: true,
  requireApproval: true,
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

const portfolio: PortfolioState = { cash: 250, equity: 250, holdings: [] };
const md = new StubMarketDataProvider();
const universe = ['SPY', 'QQQ', 'IWM', 'EFA'];

describe('Baseline strategies', () => {
  it('random baseline is deterministic per date seed', async () => {
    const res1 = await runRandomBaseline('2025-12-20', universe, config, portfolio, md);
    const res2 = await runRandomBaseline('2025-12-20', universe, config, portfolio, md);
    expect(res1.intent.orders).toEqual(res2.intent.orders);
    const res3 = await runRandomBaseline('2025-12-27', universe, config, portfolio, md);
    expect(res3.intent.orders).not.toEqual(res1.intent.orders);
  });

  it('deterministic baseline respects maxPositions', async () => {
    const res = await runDeterministicBaseline('2025-12-20', universe, config, portfolio, md);
    expect(res.intent.orders.length).toBeLessThanOrEqual(config.maxPositions);
  });
});
