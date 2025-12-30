import { BotConfig, PortfolioState, ProposalResult, TradeIntent, TradeOrder, RegimeContext } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';
import { regimeTiltForSymbol } from './regimeTilts';

interface RankedSymbol {
  symbol: string;
  momentum: number;
  score: number;
}

const lookbackDays = 7 * 12;

export const runDeterministicBaseline = async (
  asOf: string,
  universe: string[],
  config: BotConfig,
  portfolio: PortfolioState,
  marketData: MarketDataProvider,
  regimes?: RegimeContext
): Promise<ProposalResult> => {
  const ranks: RankedSymbol[] = [];
  for (const symbol of universe) {
    const history = await marketData.getHistory(symbol, asOf, lookbackDays);
    if (history.length < 2) continue;
    const first = history[0].close;
    const last = history[history.length - 1].close;
    const momentum = (last - first) / first;
    const tilt = regimeTiltForSymbol(regimes, symbol).multiplier;
    const score = momentum * tilt;
    ranks.push({ symbol, momentum, score });
  }

  ranks.sort((a, b) => b.score - a.score);
  const targetSymbols = ranks.slice(0, Math.min(config.maxPositions, ranks.length)).map((r) => r.symbol);
  const holdingsMap = new Map(portfolio.holdings.map((h) => [h.symbol, h]));
  const orders: TradeOrder[] = [];
  let sellProceeds = 0;

  // Exit holdings that are not in the current target set.
  for (const holding of portfolio.holdings) {
    if (targetSymbols.includes(holding.symbol)) continue;
    const quote = await marketData.getQuote(holding.symbol, asOf);
    const notional = Number((Math.max(holding.quantity, 0) * quote.price).toFixed(2));
    if (notional <= 0) continue;
    sellProceeds += notional;
    orders.push({
      symbol: holding.symbol,
      side: 'SELL',
      orderType: 'MARKET',
      notionalUSD: notional,
      thesis: 'Rebalance: exit non-target holding.',
      invalidation: 'Hold unless target set changes.',
      confidence: 0.5,
      portfolioLevel: { targetHoldDays: 30, netExposureTarget: 0 }
    });
  }

  // If still over maxPositions after planned exits, drop lowest-ranked holdings to free slots.
  const plannedExits = new Set(orders.filter((o) => o.side === 'SELL').map((o) => o.symbol));
  const remainingHoldings = portfolio.holdings.filter((h) => !plannedExits.has(h.symbol) && h.quantity > 0);
  if (remainingHoldings.length > config.maxPositions) {
    const rankMap = new Map(ranks.map((r) => [r.symbol, r.score]));
    const sorted = remainingHoldings.sort((a, b) => {
      const ra = rankMap.get(a.symbol) ?? -Infinity;
      const rb = rankMap.get(b.symbol) ?? -Infinity;
      return ra - rb; // lowest momentum first
    });
    const toDrop = sorted.slice(0, remainingHoldings.length - config.maxPositions);
    for (const holding of toDrop) {
      const quote = await marketData.getQuote(holding.symbol, asOf);
      const notional = Number((holding.quantity * quote.price).toFixed(2));
      if (notional <= 0) continue;
      sellProceeds += notional;
      orders.push({
        symbol: holding.symbol,
        side: 'SELL',
        orderType: 'MARKET',
        notionalUSD: notional,
        thesis: 'Rebalance: free slot for higher-ranked idea.',
        invalidation: 'Hold unless displaced by higher rank.',
        confidence: 0.45,
        portfolioLevel: { targetHoldDays: 30, netExposureTarget: 0 }
      });
    }
  }

  // Buy target symbols not already held, using available cash while respecting max position size and min cash buffer.
  const buyCandidates = targetSymbols.filter((s) => !holdingsMap.has(s));
  const minCashBuffer = portfolio.equity * config.minCashPct;
  const availableCash = Math.max(0, portfolio.cash + sellProceeds - minCashBuffer);
  const perBuyBase = buyCandidates.length ? availableCash / buyCandidates.length : 0;

  for (const symbol of buyCandidates) {
    if (perBuyBase <= 0) break;
    const target = ranks.find((r) => r.symbol === symbol);
    const cap = portfolio.equity * config.maxPositionPct;
    const per = Math.min(perBuyBase, cap > 0 ? cap - 0.01 : perBuyBase);
    orders.push({
      symbol,
      side: 'BUY',
      orderType: 'MARKET',
      notionalUSD: Number(per.toFixed(2)),
      thesis: target ? `Momentum score ${(target.momentum * 100).toFixed(2)}% (regime tilt applied)` : 'Momentum-based allocation',
      invalidation: 'Momentum reverses below short-term trend.',
      confidence: target ? Math.min(1, Math.max(0.3, target.score + 0.5)) : 0.5,
      portfolioLevel: { targetHoldDays: 60, netExposureTarget: 1 }
    });
  }

  const intent: TradeIntent = {
    asOf,
    universe,
    orders
  };

  return { strategy: 'deterministic', intent };
};
