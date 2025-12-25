import { BotConfig, PortfolioState, TradeOrder } from '../core/types';

export const countFuturePositions = (orders: TradeOrder[], portfolio: PortfolioState): number => {
  const held = new Set(portfolio.holdings.map((h) => h.symbol));
  for (const order of orders) {
    if (order.side === 'BUY') {
      held.add(order.symbol);
    } else if (order.side === 'SELL') {
      held.delete(order.symbol);
    }
  }
  return held.size;
};

export const totalBuyNotional = (orders: TradeOrder[]): number =>
  orders.filter((o) => o.side === 'BUY').reduce((sum, o) => sum + o.notionalUSD, 0);

export const totalSellNotional = (orders: TradeOrder[]): number =>
  orders.filter((o) => o.side === 'SELL').reduce((sum, o) => sum + o.notionalUSD, 0);

export const totalAbsoluteNotional = (orders: TradeOrder[]): number =>
  orders.reduce((sum, o) => sum + Math.abs(o.notionalUSD), 0);

export const violatesMaxTrades = (orders: TradeOrder[], maxTrades: number): boolean => orders.length > maxTrades;

export const violatesUniverse = (orders: TradeOrder[], universe: string[]): TradeOrder[] =>
  orders.filter((o) => o.side === 'BUY' && !universe.includes(o.symbol));

export const violatesPositionSize = (orders: TradeOrder[], equity: number, maxPct: number): TradeOrder[] =>
  orders.filter((o) => o.side === 'BUY' && o.notionalUSD > equity * maxPct);

export const insufficientCash = (
  orders: TradeOrder[],
  portfolio: PortfolioState,
  minCashPct: number
): boolean => {
  const spend = totalBuyNotional(orders) - totalSellNotional(orders);
  const minCash = portfolio.equity * minCashPct;
  const projected = portfolio.cash - spend;
  return projected < Math.max(0, minCash);
};

export const hasShorting = (orders: TradeOrder[], holdings: PortfolioState['holdings']): TradeOrder[] => {
  const held = new Set(holdings.map((h) => h.symbol));
  return orders.filter((o) => o.side === 'SELL' && !held.has(o.symbol));
};

export const violatesTurnoverCap = (orders: TradeOrder[], equity: number, maxPct: number): boolean => {
  if (maxPct <= 0) return false;
  const total = totalBuyNotional(orders);
  return total > equity * maxPct;
};

export const violatesMinHold = (
  orders: TradeOrder[],
  holdings: PortfolioState['holdings'],
  asOf: string,
  minHoldHours: number
): TradeOrder[] => {
  if (minHoldHours <= 0) return [];
  const asOfTs = new Date(asOf).getTime();
  return orders.filter((o) => {
    if (o.side !== 'SELL') return false;
    const held = holdings.find((h) => h.symbol === o.symbol);
    if (!held?.holdSince) return false;
    const heldTs = new Date(held.holdSince).getTime();
    if (Number.isNaN(heldTs) || Number.isNaN(asOfTs)) return false;
    const hoursHeld = (asOfTs - heldTs) / (1000 * 60 * 60);
    return hoursHeld < minHoldHours;
  });
};
