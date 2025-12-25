import { validateTradeIntent } from '../src/core/schema';

describe('TradeIntent schema', () => {
  const universe = ['SPY', 'QQQ'];

  it('accepts valid payload', () => {
    const intent = {
      asOf: '2025-12-20',
      universe,
      orders: [
        {
          symbol: 'SPY',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 100,
          thesis: 'Broad market exposure',
          invalidation: 'Breaks 50dma',
          confidence: 0.8,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
        }
      ]
    };

    const res = validateTradeIntent(intent, universe);
    expect(res.success).toBe(true);
  });

  it('rejects symbols outside universe', () => {
    const intent = {
      asOf: '2025-12-20',
      universe,
      orders: [
        {
          symbol: 'ABC',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 100,
          thesis: 'Invalid symbol',
          invalidation: 'N/A',
          confidence: 0.5,
          portfolioLevel: { targetHoldDays: 10, netExposureTarget: 1 }
        }
      ]
    };
    const res = validateTradeIntent(intent, universe);
    expect(res.success).toBe(false);
  });
});
