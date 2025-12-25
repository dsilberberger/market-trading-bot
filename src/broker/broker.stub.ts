import { BotConfig, Fill, OrderPlacement, OrderPreview, PortfolioState, TradeOrder } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';
import { readLedgerEvents } from '../ledger/storage';
import { hashString } from '../core/utils';

interface FillEventDetails {
  fill: Fill;
}

export class StubBroker {
  private config: BotConfig;
  private marketData: MarketDataProvider;
  private pending: Record<string, { symbol: string; quantity: number; price: number; side: 'BUY' | 'SELL' }> = {};

  constructor(config: BotConfig, marketData: MarketDataProvider) {
    this.config = config;
    this.marketData = marketData;
  }

  async getPortfolioState(asOf: string): Promise<PortfolioState> {
    const events = readLedgerEvents();
    const cutoff = new Date(asOf.includes('T') ? asOf : `${asOf}T23:59:59Z`).getTime();
    let cash = this.config.startingCapitalUSD;
    const holdings: Record<string, { quantity: number; avgPrice: number; holdSince?: number }> = {};

    for (const evt of events) {
      const ts = new Date(evt.timestamp).getTime();
      if (Number.isNaN(ts) || ts > cutoff) continue;
      if (evt.type !== 'FILL_RECORDED') continue;
      const detail = evt.details as FillEventDetails | undefined;
      if (!detail || !detail.fill) continue;
      const fill = detail.fill;
      const direction = fill.side === 'BUY' ? 1 : -1;
      const qty = direction * fill.quantity;
      cash -= direction * fill.notional;
      const current = holdings[fill.symbol] || { quantity: 0, avgPrice: 0, holdSince: undefined as number | undefined };
      const newQty = current.quantity + qty;
      const cost = current.avgPrice * current.quantity + direction * fill.notional;
      const avgPrice = newQty !== 0 ? cost / newQty : current.avgPrice;
      let holdSince = current.holdSince;
      if (direction === 1 && current.quantity === 0 && newQty > 0) {
        holdSince = ts;
      }
      if (direction === -1 && newQty <= 0) {
        holdSince = undefined;
      }
      holdings[fill.symbol] = { quantity: newQty, avgPrice, holdSince };
      if (holdings[fill.symbol].quantity <= 0) {
        delete holdings[fill.symbol];
      }
    }

    const pricedHoldings = await Promise.all(
      Object.entries(holdings).map(async ([symbol, pos]) => {
        const quote = await this.marketData.getQuote(symbol, asOf);
        return { symbol, quantity: pos.quantity, avgPrice: pos.avgPrice, mark: quote.price, holdSince: pos.holdSince };
      })
    );

    const equityFromHoldings = pricedHoldings.reduce((acc, h) => acc + h.quantity * h.mark, 0);
    const equity = cash + equityFromHoldings;
    return {
      cash,
      holdings: pricedHoldings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        holdSince: h.holdSince ? new Date(h.holdSince).toISOString() : undefined
      })),
      equity
    };
  }

  async previewOrder(order: TradeOrder, asOf: string): Promise<OrderPreview> {
    const quote = await this.marketData.getQuote(order.symbol, asOf);
    const slip = order.side === 'BUY' ? 1 + this.config.slippageBps / 10000 : 1 - this.config.slippageBps / 10000;
    const px = quote.price * slip;
    const quantity = order.notionalUSD / px;
    const fees = this.config.commissionPerTradeUSD;
    return {
      symbol: order.symbol,
      quantity,
      estimatedCost: quantity * px,
      fees
    };
  }

  async placeOrder(order: TradeOrder, asOf: string): Promise<OrderPlacement> {
    const preview = await this.previewOrder(order, asOf);
    const orderId = `ord-${order.symbol}-${hashString(`${order.symbol}-${asOf}-${Math.random()}`)}`;
    this.pending[orderId] = {
      symbol: order.symbol,
      quantity: preview.quantity,
      price: preview.estimatedCost / preview.quantity,
      side: order.side
    };
    return { ...preview, orderId };
  }

  async getFills(orderIds: string[], asOf: string): Promise<Fill[]> {
    const fills: Fill[] = [];
    for (const id of orderIds) {
      const pending = this.pending[id];
      const symbol = pending?.symbol || (typeof id === 'string' ? id.split('-')[1] : 'UNK');
      const quote = await this.marketData.getQuote(symbol, asOf);
      const price = pending?.price ?? quote.price;
      const quantity = pending?.quantity ?? 0;
      const side = pending?.side ?? 'BUY';
      const ts = asOf.includes('T') ? new Date(asOf) : new Date(`${asOf}T12:00:00Z`);
      fills.push({
        orderId: id,
        symbol,
        side,
        quantity,
        price,
        notional: price * quantity,
        timestamp: ts.toISOString()
      });
      if (pending) {
        delete this.pending[id];
      }
    }
    return fills;
  }

  async cancelOrder(_orderId: string): Promise<void> {
    return;
  }
}
