import { Broker } from '../broker/broker.types';
import { BotConfig, Fill, OptionCashEvent, OptionPosition, OrderPlacement, OrderPreview, PortfolioState, TradeOrder } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';

type PositionState = {
  quantity: number;
  avgPrice: number;
  holdSince?: string;
};

type PendingOrder = {
  order: TradeOrder;
  quantity: number;
  price: number;
};

type ReplayOptionPositionState = {
  positionId: string;
  underlying: string;
  optionSymbol: string;
  type: 'PUT' | 'CALL';
  sleeve: 'insurance' | 'growth';
  strike: number;
  expiry: string;
  contracts: number;
  multiplier: number;
  avgOpenPrice: number;
  openDate: string;
  costBasisUsd: number;
};

export interface ReplayBrokerState {
  cash: number;
  holdings: Record<string, PositionState>;
  optionPositions: ReplayOptionPositionState[];
}

const cloneState = (state: ReplayBrokerState): ReplayBrokerState => ({
  cash: state.cash,
  holdings: Object.fromEntries(Object.entries(state.holdings).map(([symbol, position]) => [symbol, { ...position }])),
  optionPositions: state.optionPositions.map((position) => ({ ...position }))
});

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const CONTRACT_MULTIPLIER = 100;
const SELL_QUANTITY_TOLERANCE = 1e-6;

const derivePositionId = (underlying: string, type: 'PUT' | 'CALL', strike: number, expiry: string) =>
  `${underlying}:${type}:${strike.toFixed(4)}:${expiry}`;

const optionIntrinsicPerShare = (type: 'PUT' | 'CALL', strike: number, spot: number) =>
  type === 'PUT' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);

export class ReplayBroker implements Broker {
  private readonly config: BotConfig;
  private readonly marketData: MarketDataProvider;
  private readonly pending = new Map<string, PendingOrder>();
  private readonly state: ReplayBrokerState;
  private readonly optionCashEvents: OptionCashEvent[] = [];
  private nextOrderId = 1;

  constructor(config: BotConfig, marketData: MarketDataProvider, initialPortfolio: PortfolioState) {
    this.config = config;
    this.marketData = marketData;
    this.state = {
      cash: initialPortfolio.cash || 0,
      holdings: Object.fromEntries(
        (initialPortfolio.holdings || []).map((holding) => [
          holding.symbol,
          {
            quantity: holding.quantity,
            avgPrice: holding.avgPrice,
            holdSince: holding.holdSince
          }
        ])
      ),
      optionPositions: []
    };
  }

  snapshotState(): ReplayBrokerState {
    return cloneState(this.state);
  }

  async getPortfolioState(asOf: string): Promise<PortfolioState> {
    const holdings = await Promise.all(
      Object.entries(this.state.holdings).map(async ([symbol, position]) => {
        const quote = await this.marketData.getQuote(symbol, asOf);
        return {
          symbol,
          quantity: position.quantity,
          avgPrice: position.avgPrice,
          holdSince: position.holdSince,
          mark: quote.price
        };
      })
    );
    const holdingsValue = holdings.reduce((sum, holding) => sum + holding.quantity * holding.mark, 0);
    const optionPositions = await this.markOptionPositions(asOf);
    const optionsMarketValueUsd = optionPositions.reduce((sum, position) => sum + (position.marketValueUsd || 0), 0);
    return {
      cash: this.state.cash,
      holdings: holdings.map(({ mark: _mark, ...holding }) => holding),
      equity: this.state.cash + holdingsValue + optionsMarketValueUsd,
      optionPositions,
      optionsMarketValueUsd
    };
  }

  async getOptionPositions(asOf: string): Promise<OptionPosition[]> {
    return this.markOptionPositions(asOf);
  }

  async getOptionQuote(optionSymbol: string, asOf: string): Promise<{ price: number }> {
    const position =
      this.state.optionPositions.find((entry) => entry.optionSymbol === optionSymbol) ||
      this.state.optionPositions.find((entry) => entry.underlying === optionSymbol);
    if (!position) return { price: 0 };
    const marked = await this.markOptionPosition(position, asOf);
    return { price: marked.marketPrice ?? 0 };
  }

  startReplayStep() {
    this.optionCashEvents.length = 0;
  }

  drainOptionCashEvents(): OptionCashEvent[] {
    return this.optionCashEvents.splice(0, this.optionCashEvents.length);
  }

  async expireOptionPositions(asOf: string): Promise<OptionCashEvent[]> {
    const nextPositions: ReplayOptionPositionState[] = [];
    const asOfTime = new Date(asOf).getTime();
    for (const position of this.state.optionPositions) {
      const expiryTime = new Date(`${position.expiry}T23:59:59.999Z`).getTime();
      if (asOfTime < expiryTime) {
        nextPositions.push(position);
        continue;
      }
      const quote = await this.marketData.getQuote(position.underlying, asOf);
      const intrinsicPerShare = optionIntrinsicPerShare(position.type, position.strike, quote.price);
      const credit = intrinsicPerShare * position.contracts * position.multiplier;
      if (credit > 0) this.state.cash += credit;
      this.optionCashEvents.push({
        date: asOf.slice(0, 10),
        asOf,
        type: 'OPT_EXPIRE',
        amount: credit,
        reason: `${position.sleeve}_expire`,
        symbol: position.underlying,
        sleeve: position.sleeve,
        positionId: position.positionId,
        contracts: position.contracts,
        strike: position.strike,
        expiry: position.expiry
      });
    }
    this.state.optionPositions = nextPositions;
    return this.drainOptionCashEvents();
  }

  async openInsuranceOption(
    input: {
      underlying: string;
      strike: number;
      expiry?: string | null;
      contracts: number;
      premiumPerShare: number;
    },
    asOf: string
  ): Promise<OptionCashEvent | null> {
    return this.openOptionPosition(
      {
        sleeve: 'insurance',
        type: 'PUT',
        ...input
      },
      asOf
    );
  }

  async openGrowthOption(
    input: {
      underlying: string;
      strike: number;
      expiry?: string | null;
      contracts: number;
      premiumPerShare: number;
    },
    asOf: string
  ): Promise<OptionCashEvent | null> {
    return this.openOptionPosition(
      {
        sleeve: 'growth',
        type: 'CALL',
        ...input
      },
      asOf
    );
  }

  async closeInsuranceOption(asOf: string, reason = 'insurance_close'): Promise<OptionCashEvent[]> {
    return this.closeOptionsForSleeve('insurance', asOf, reason);
  }

  async closeGrowthOption(asOf: string, reason = 'growth_close'): Promise<OptionCashEvent[]> {
    return this.closeOptionsForSleeve('growth', asOf, reason);
  }

  private async openOptionPosition(
    input: {
      sleeve: 'insurance' | 'growth';
      type: 'PUT' | 'CALL';
      underlying: string;
      strike: number;
      expiry?: string | null;
      contracts: number;
      premiumPerShare: number;
    },
    asOf: string
  ): Promise<OptionCashEvent | null> {
    const contracts = Math.max(0, Math.floor(input.contracts));
    if (contracts < 1 || input.premiumPerShare <= 0) return null;
    const expiry = this.normalizeExpiry(input.expiry || '', asOf, input.sleeve);
    const costBasisUsd = input.premiumPerShare * contracts * CONTRACT_MULTIPLIER;
    if (costBasisUsd > this.state.cash + 1e-6) return null;
    const position: ReplayOptionPositionState = {
      positionId: derivePositionId(input.underlying, input.type, input.strike, expiry),
      underlying: input.underlying,
      optionSymbol: derivePositionId(input.underlying, input.type, input.strike, expiry),
      type: input.type,
      sleeve: input.sleeve,
      strike: input.strike,
      expiry,
      contracts,
      multiplier: CONTRACT_MULTIPLIER,
      avgOpenPrice: input.premiumPerShare,
      openDate: asOf,
      costBasisUsd
    };
    this.state.cash -= costBasisUsd;
    this.state.optionPositions.push(position);
    const event: OptionCashEvent = {
      date: asOf.slice(0, 10),
      asOf,
      type: 'OPT_OPEN_DEBIT',
      amount: -costBasisUsd,
      reason: `${input.sleeve}_open`,
      symbol: input.underlying,
      sleeve: input.sleeve,
      positionId: position.positionId,
      contracts,
      strike: input.strike,
      expiry
    };
    this.optionCashEvents.push(event);
    return event;
  }

  private async closeOptionsForSleeve(
    sleeve: 'insurance' | 'growth',
    asOf: string,
    reason: string
  ): Promise<OptionCashEvent[]> {
    const positions = this.state.optionPositions.filter((entry) => entry.sleeve === sleeve);
    if (!positions.length) return [];
    const events: OptionCashEvent[] = [];
    for (const position of positions) {
      const marked = await this.markOptionPosition(position, asOf);
      const credit = marked.marketValueUsd || 0;
      this.state.cash += credit;
      const event: OptionCashEvent = {
        date: asOf.slice(0, 10),
        asOf,
        type: 'OPT_CLOSE_CREDIT',
        amount: credit,
        reason,
        symbol: position.underlying,
        sleeve: position.sleeve,
        positionId: position.positionId,
        contracts: position.contracts,
        strike: position.strike,
        expiry: position.expiry
      };
      this.optionCashEvents.push(event);
      events.push(event);
    }
    this.state.optionPositions = this.state.optionPositions.filter((entry) => entry.sleeve !== sleeve);
    return events;
  }

  getExecutedOptionReserveUsageUsd() {
    return this.state.optionPositions.reduce((sum, position) => sum + position.costBasisUsd, 0);
  }

  private reconcileReplaySellQuantity(order: TradeOrder, quotePrice: number, previewQuantity: number) {
    if (order.side !== 'SELL') return previewQuantity;
    const currentQty = this.state.holdings[order.symbol]?.quantity || 0;
    if (currentQty <= 0 || quotePrice <= 0) return previewQuantity;
    const quantityAtQuote = (order.notionalUSD || 0) / quotePrice;

    // Rebalance sells are sized from current holdings at the unslipped quote.
    // When replay applies sell-side slippage, the implied quantity can drift just
    // above the held size even though the unslipped intent was valid. Clamp only
    // in that narrow case; true oversells still fail downstream.
    if (quantityAtQuote <= currentQty + SELL_QUANTITY_TOLERANCE && previewQuantity > currentQty) {
      return currentQty;
    }

    return previewQuantity;
  }

  async previewOrder(order: TradeOrder, asOf: string): Promise<OrderPreview> {
    const quote = await this.marketData.getQuote(order.symbol, asOf);
    const slip = order.side === 'BUY' ? 1 + this.config.slippageBps / 10000 : 1 - this.config.slippageBps / 10000;
    const price = quote.price * slip;
    const rawQuantity = price > 0 ? order.notionalUSD / price : 0;
    const quantity = this.reconcileReplaySellQuantity(order, quote.price, rawQuantity);
    return {
      symbol: order.symbol,
      quantity,
      estimatedCost: quantity * price,
      fees: this.config.commissionPerTradeUSD
    };
  }

  async placeOrder(order: TradeOrder, asOf: string): Promise<OrderPlacement> {
    const preview = await this.previewOrder(order, asOf);
    if (order.side === 'BUY' && preview.estimatedCost + preview.fees > this.state.cash + 1e-6) {
      throw new Error(`Insufficient cash for ${order.symbol} buy at ${asOf}`);
    }
    if (order.side === 'SELL') {
      const currentQty = this.state.holdings[order.symbol]?.quantity || 0;
      if (preview.quantity > currentQty + 1e-6) {
        throw new Error(`Insufficient holdings for ${order.symbol} sell at ${asOf}`);
      }
    }
    const orderId = `replay-${this.nextOrderId++}`;
    this.pending.set(orderId, {
      order,
      quantity: preview.quantity,
      price: preview.quantity > 0 ? preview.estimatedCost / preview.quantity : 0
    });
    return { ...preview, orderId };
  }

  async getFills(orderIds: string[], asOf: string): Promise<Fill[]> {
    const fills: Fill[] = [];
    for (const orderId of orderIds) {
      const pending = this.pending.get(orderId);
      if (!pending) continue;
      const fill: Fill = {
        orderId,
        symbol: pending.order.symbol,
        side: pending.order.side,
        quantity: pending.quantity,
        price: pending.price,
        notional: pending.quantity * pending.price,
        timestamp: new Date(asOf.includes('T') ? asOf : `${asOf}T16:00:00Z`).toISOString()
      };
      this.applyFill(fill);
      fills.push(fill);
      this.pending.delete(orderId);
    }
    return fills;
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.pending.delete(orderId);
  }

  private applyFill(fill: Fill) {
    if (fill.side === 'BUY') {
      const current = this.state.holdings[fill.symbol] || { quantity: 0, avgPrice: fill.price };
      const nextQty = current.quantity + fill.quantity;
      const nextCost = current.avgPrice * current.quantity + fill.notional;
      this.state.holdings[fill.symbol] = {
        quantity: nextQty,
        avgPrice: nextQty > 0 ? nextCost / nextQty : fill.price,
        holdSince: current.holdSince || fill.timestamp
      };
      this.state.cash -= fill.notional;
      return;
    }

    const current = this.state.holdings[fill.symbol];
    const nextQty = (current?.quantity || 0) - fill.quantity;
    this.state.cash += fill.notional;
    if (nextQty <= 1e-9) {
      delete this.state.holdings[fill.symbol];
      return;
    }
    this.state.holdings[fill.symbol] = {
      quantity: nextQty,
      avgPrice: current?.avgPrice || fill.price,
      holdSince: current?.holdSince
    };
  }

  private async markOptionPositions(asOf: string): Promise<OptionPosition[]> {
    return Promise.all(this.state.optionPositions.map((position) => this.markOptionPosition(position, asOf)));
  }

  private normalizeExpiry(expiry: string, openAsOf: string, sleeve: 'insurance' | 'growth') {
    if (expiry) return expiry;
    const minMonths = sleeve === 'growth' ? this.config.growth?.minMonths ?? 3 : this.config.insurance?.minMonths ?? 3;
    const days = Math.max(1, Math.round(minMonths * 28));
    const openDate = new Date(openAsOf);
    openDate.setUTCDate(openDate.getUTCDate() + days);
    return openDate.toISOString().slice(0, 10);
  }

  private async markOptionPosition(position: ReplayOptionPositionState, asOf: string): Promise<OptionPosition> {
    const quote = await this.marketData.getQuote(position.underlying, asOf);
    const asOfDate = new Date(asOf);
    const expiryDate = new Date(`${position.expiry}T23:59:59.999Z`);
    const daysToExpiry = Math.max(0, Math.ceil((expiryDate.getTime() - asOfDate.getTime()) / MS_PER_DAY));
    const sameDayOpen = position.openDate.slice(0, 10) === asOf.slice(0, 10);
    const weeksToExpiry = daysToExpiry / 7;
    const intrinsic = optionIntrinsicPerShare(position.type, position.strike, quote.price);
    const theta = weeksToExpiry / Math.max(weeksToExpiry + 8, 8);
    const extrinsic = sameDayOpen ? position.avgOpenPrice : position.avgOpenPrice * theta;
    const marketPrice = intrinsic + extrinsic;
    const marketValueUsd = marketPrice * position.contracts * position.multiplier;
    return {
      underlying: position.underlying,
      optionSymbol: position.optionSymbol,
      type: position.type,
      strike: position.strike,
      expiry: position.expiry,
      contracts: position.contracts,
      multiplier: position.multiplier,
      avgOpenPrice: position.avgOpenPrice,
      openDate: position.openDate,
      costBasisUsd: position.costBasisUsd,
      marketPrice,
      marketValueUsd,
      unrealizedPnlUsd: marketValueUsd - position.costBasisUsd
    };
  }
}
