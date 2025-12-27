import fs from 'fs';
import path from 'path';
import { PortfolioState, TradeOrder } from '../core/types';

const safeLoad = <T = any>(runId: string, file: string): T | undefined => {
  const p = path.resolve(process.cwd(), 'runs', runId, file);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return undefined;
  }
};

const portfolioValue = (portfolio: PortfolioState, quotes: Record<string, number>) => {
  let equity = portfolio.cash || 0;
  for (const h of portfolio.holdings || []) {
    equity += h.quantity * (quotes[h.symbol] || 0);
  }
  return equity;
};

export const generateRound6Metrics = (runId: string) => {
  const inputs = safeLoad<any>(runId, 'inputs.json');
  const orders = safeLoad<TradeOrder[]>(runId, 'orders.json') || [];
  const fills = safeLoad<any[]>(runId, 'fills.json') || [];
  const disloc = safeLoad<any>(runId, 'dislocation_state.json') || {};
  const quotes = inputs?.quotes || {};
  const equity = portfolioValue(inputs?.portfolio || { cash: 0, holdings: [], equity: 0 }, quotes);
  const totalNotional = orders.reduce((acc, o) => acc + (o.notionalUSD || 0), 0);
  const turnoverPct = equity ? totalNotional / equity : 0;
  const metrics = {
    asOf: inputs?.asOf,
    equity,
    ordersPlaced: orders.length,
    fillsRecorded: fills.length,
    totalNotional,
    turnoverPct,
    dislocationPhase: disloc?.phase || 'INACTIVE'
  };
  const outPath = path.resolve(process.cwd(), 'runs', runId, 'round6_metrics.json');
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
  return metrics;
};
