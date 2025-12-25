import { BotConfig, EquityPoint, Fill } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';
import { readLedgerEvents } from '../ledger/storage';
import { runIdToAsOf } from '../core/time';

const applyFill = (
  fill: Fill,
  state: { cash: number; holdings: Record<string, { qty: number; cost: number }> }
) => {
  const direction = fill.side === 'BUY' ? 1 : -1;
  const qty = direction * fill.quantity;
  const current = state.holdings[fill.symbol] || { qty: 0, cost: 0 };
  const newQty = current.qty + qty;
  const newCost = current.cost + direction * fill.notional;
  state.holdings[fill.symbol] = { qty: newQty, cost: newCost };
  if (state.holdings[fill.symbol].qty === 0) delete state.holdings[fill.symbol];
  state.cash -= direction * fill.notional;
};

const markToMarket = async (
  asOf: string,
  marketData: MarketDataProvider,
  state: { cash: number; holdings: Record<string, { qty: number; cost: number }> }
) => {
  let holdingsValue = 0;
  for (const [symbol, pos] of Object.entries(state.holdings)) {
    const quote = await marketData.getQuote(symbol, asOf);
    holdingsValue += pos.qty * quote.price;
  }
  const equity = state.cash + holdingsValue;
  const exposure = equity > 0 ? holdingsValue / equity : 0;
  return { equity, exposure };
};

export const buildEquityCurve = async (
  config: BotConfig,
  marketData: MarketDataProvider
): Promise<EquityPoint[]> => {
  const events = readLedgerEvents();
  const runs = Array.from(new Set(events.map((e) => e.runId)));
  runs.sort((a, b) => {
    const aTime = Math.min(
      ...events.filter((e) => e.runId === a).map((e) => new Date(e.timestamp).getTime())
    );
    const bTime = Math.min(
      ...events.filter((e) => e.runId === b).map((e) => new Date(e.timestamp).getTime())
    );
    return aTime - bTime;
  });
  const state = { cash: config.startingCapitalUSD, holdings: {} as Record<string, { qty: number; cost: number }> };
  const points: EquityPoint[] = [];
  let peak = config.startingCapitalUSD;

  for (const runId of runs) {
    const asOfForRun = runIdToAsOf(runId);
    const runEvents = events.filter((e) => e.runId === runId && e.type === 'FILL_RECORDED');
    for (const evt of runEvents) {
      const detail = evt.details as { fill?: Fill } | undefined;
      if (!detail?.fill) continue;
      applyFill(detail.fill, state);
    }
    const { equity, exposure } = await markToMarket(asOfForRun, marketData, state);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    const spyQuote = await marketData.getQuote('SPY', asOfForRun);
    points.push({
      date: asOfForRun,
      equity,
      exposure,
      drawdown,
      benchmarkSPY: spyQuote.price,
      deterministicEquity: equity,
      randomEquity: equity
    });
  }

  return points;
};

export const currentDrawdown = async (
  config: BotConfig,
  marketData: MarketDataProvider
): Promise<number> => {
  const curve = await buildEquityCurve(config, marketData);
  if (!curve.length) return 0;
  return curve[curve.length - 1].drawdown;
};
