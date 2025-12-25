import { BotConfig, PortfolioState, ProposalResult, TradeIntent, TradeOrder } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';
import { mulberry32 } from '../core/utils';
import { seedFromDate } from '../core/time';

export const runRandomBaseline = async (
  asOf: string,
  universe: string[],
  config: BotConfig,
  portfolio: PortfolioState,
  _marketData: MarketDataProvider
): Promise<ProposalResult> => {
  const rng = mulberry32(seedFromDate(asOf));
  const shuffled = universe.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picks = shuffled.slice(0, Math.min(config.maxPositions, shuffled.length));
  const cashToDeploy = portfolio.cash * (1 - config.minCashPct);
  const per = picks.length ? Math.min(cashToDeploy / picks.length, portfolio.equity * config.maxPositionPct) : 0;
  const orders: TradeOrder[] = picks.map((symbol, idx) => ({
    symbol,
    side: 'BUY',
    orderType: 'MARKET',
    notionalUSD: Number(per.toFixed(2)),
    thesis: `Seeded random pick #${idx + 1}`,
    invalidation: 'Auto-sell after a week or adverse move.',
    confidence: 0.4,
    portfolioLevel: { targetHoldDays: 7, netExposureTarget: 1 }
  }));

  const intent: TradeIntent = { asOf, universe, orders };
  return { strategy: 'random', intent };
};
