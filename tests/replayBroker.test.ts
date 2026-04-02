import { ReplayBroker } from '../src/replay/replayBroker';
import { BotConfig, PortfolioState, TradeOrder } from '../src/core/types';
import { MarketDataProvider } from '../src/data/marketData.types';

const makeConfig = (slippageBps = 5): BotConfig =>
  ({
    slippageBps,
    commissionPerTradeUSD: 0,
    capital: { corePct: 0.85, reservePct: 0.15 },
    rebalance: { enabled: true }
  }) as BotConfig;

const makeMarketData = (price = 100): MarketDataProvider => ({
  async getQuote(symbol: string, asOf: string) {
    return { symbol, price, asOf };
  },
  async getHistory() {
    return [];
  }
});

const makePortfolio = (quantity: number, cash = 0): PortfolioState => ({
  cash,
  equity: cash + quantity * 100,
  holdings: [{ symbol: 'VTI', quantity, avgPrice: 100, holdSince: '2024-01-01T00:00:00.000Z' }]
});

describe('ReplayBroker sell execution', () => {
  it('fills a valid sell sized from an existing holding under sell-side slippage', async () => {
    const heldQty = 0.9995002498750625;
    const broker = new ReplayBroker(makeConfig(5), makeMarketData(100), makePortfolio(heldQty));
    const order: TradeOrder = {
      symbol: 'VTI',
      side: 'SELL',
      orderType: 'MARKET',
      notionalUSD: heldQty * 100,
      thesis: 'trim',
      invalidation: '',
      confidence: 0.7,
      portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
    };

    const preview = await broker.previewOrder(order, '2024-02-01T16:00:00Z');
    expect(preview.quantity).toBeCloseTo(heldQty, 12);

    const placement = await broker.placeOrder(order, '2024-02-01T16:00:00Z');
    const fills = await broker.getFills([String(placement.orderId)], '2024-02-01T16:00:00Z');
    const portfolio = await broker.getPortfolioState('2024-02-01T16:00:00Z');

    expect(fills).toHaveLength(1);
    expect(fills[0].quantity).toBeCloseTo(heldQty, 12);
    expect(portfolio.holdings).toHaveLength(0);
    expect(portfolio.cash).toBeCloseTo(heldQty * 99.95, 8);
  });

  it('still rejects a true oversell attempt', async () => {
    const broker = new ReplayBroker(makeConfig(5), makeMarketData(100), makePortfolio(1));
    const order: TradeOrder = {
      symbol: 'VTI',
      side: 'SELL',
      orderType: 'MARKET',
      notionalUSD: 120,
      thesis: 'oversell',
      invalidation: '',
      confidence: 0.7,
      portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
    };

    await expect(broker.placeOrder(order, '2024-02-01T16:00:00Z')).rejects.toThrow(
      'Insufficient holdings for VTI sell'
    );
  });

  it('is deterministic for repeated previews of the same valid sell', async () => {
    const heldQty = 0.9995002498750625;
    const broker = new ReplayBroker(makeConfig(5), makeMarketData(100), makePortfolio(heldQty));
    const order: TradeOrder = {
      symbol: 'VTI',
      side: 'SELL',
      orderType: 'MARKET',
      notionalUSD: heldQty * 100,
      thesis: 'trim',
      invalidation: '',
      confidence: 0.7,
      portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
    };

    const first = await broker.previewOrder(order, '2024-02-01T16:00:00Z');
    const second = await broker.previewOrder(order, '2024-02-01T16:00:00Z');

    expect(second).toEqual(first);
  });
});
