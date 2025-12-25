import { evaluateRisk } from '../src/risk/riskEngine';
import { BotConfig, PortfolioState, TradeIntent } from '../src/core/types';

describe('Risk Engine', () => {
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

  it('blocks when max trades exceeded', () => {
    const intent: TradeIntent = {
      asOf: '2025-12-20T00:00',
      universe: ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM'],
      orders: new Array(5).fill(null).map((_, idx) => ({
        symbol: ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM'][idx],
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: 50,
        thesis: 'Test',
        invalidation: 'Test',
        confidence: 0.5,
        portfolioLevel: { targetHoldDays: 7, netExposureTarget: 1 }
      }))
    };

    const res = evaluateRisk(intent, config, portfolio, { drawdown: 0 });
    expect(res.approved).toBe(false);
    expect(res.blockedReasons.join(' ')).toMatch(/Too many trades/);
  });

  it('blocks buys on drawdown breach', () => {
    const intent: TradeIntent = {
      asOf: '2025-12-20T00:00',
      universe: ['SPY'],
      orders: [
        {
          symbol: 'SPY',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 100,
          thesis: 'Buy dip',
          invalidation: 'Breaks support',
          confidence: 0.6,
          portfolioLevel: { targetHoldDays: 7, netExposureTarget: 1 }
        }
      ]
    };

    const res = evaluateRisk(intent, config, portfolio, { drawdown: 0.2 });
    expect(res.approved).toBe(false);
    expect(res.blockedReasons.join(' ')).toMatch(/Drawdown limit/);
  });

  it('blocks when turnover cap exceeded', () => {
    const intent: TradeIntent = {
      asOf: '2025-12-20T00:00',
      universe: ['SPY', 'QQQ'],
      orders: [
        {
          symbol: 'SPY',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 100,
          thesis: 'Test',
          invalidation: 'Test',
          confidence: 0.5,
          portfolioLevel: { targetHoldDays: 7, netExposureTarget: 1 }
        },
        {
          symbol: 'QQQ',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 100,
          thesis: 'Test',
          invalidation: 'Test',
          confidence: 0.5,
          portfolioLevel: { targetHoldDays: 7, netExposureTarget: 1 }
        }
      ]
    };
    const res = evaluateRisk(intent, config, portfolio, { drawdown: 0 });
    expect(res.approved).toBe(false);
    expect(res.blockedReasons.join(' ')).toMatch(/Turnover/);
  });

  it('blocks when min hold hours not satisfied', () => {
    const recent = new Date('2025-12-19T12:00:00Z').toISOString();
    const heldPortfolio: PortfolioState = {
      cash: 100,
      equity: 250,
      holdings: [{ symbol: 'SPY', quantity: 1, avgPrice: 150, holdSince: recent }]
    };
    const intent: TradeIntent = {
      asOf: '2025-12-20T00:00',
      universe: ['SPY'],
      orders: [
        {
          symbol: 'SPY',
          side: 'SELL',
          orderType: 'MARKET',
          notionalUSD: 150,
          thesis: 'Test',
          invalidation: 'Test',
          confidence: 0.5,
          portfolioLevel: { targetHoldDays: 7, netExposureTarget: 0 }
        }
      ]
    };
    const res = evaluateRisk(intent, config, heldPortfolio, { drawdown: 0 });
    expect(res.approved).toBe(false);
    expect(res.blockedReasons.join(' ')).toMatch(/Min hold/);
  });
});
