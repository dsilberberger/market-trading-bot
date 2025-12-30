import { runDeterministicBaseline } from '../src/strategy/deterministicBaseline';
import { BotConfig, PortfolioState, RegimeContext } from '../src/core/types';
import { MarketDataProvider, PriceBar, Quote } from '../src/data/marketData.types';

const asOf = '2025-01-07';

class StubMarketData implements MarketDataProvider {
  private histories: Record<string, PriceBar[]>;
  constructor(histories: Record<string, number[]>) {
    this.histories = Object.fromEntries(
      Object.entries(histories).map(([sym, prices]) => [
        sym,
        prices.map((p, idx) => ({ date: `2024-12-${10 + idx}`, close: p }))
      ])
    );
  }
  async getQuote(symbol: string, date: string): Promise<Quote> {
    const hist = this.histories[symbol];
    const last = hist?.[hist.length - 1]?.close || 0;
    return { symbol, price: last, asOf: date };
  }
  async getHistory(symbol: string): Promise<PriceBar[]> {
    return this.histories[symbol] || [];
  }
}

const baseConfig: BotConfig = {
  startingCapitalUSD: 1000,
  capital: { corePct: 0.7, reservePct: 0.3 },
  maxPositions: 1,
  rebalanceDay: 'TUESDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.5,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0,
  maxNotionalTradedPctPerRun: 1,
  minHoldHours: 0,
  rebalance: { enabled: true },
  cadence: 'weekly',
  policyGateMode: 'scale',
  round0MacroLagPolicy: 'flags_warn',
  macroLagWarnDays: 45,
  macroLagErrorDays: 120,
  minExecutableNotionalUSD: 1,
  fractionalSharesSupported: false,
  allowExecutionProxies: false,
  proxiesFile: '',
  proxySelectionMode: 'first_executable',
  maxProxyTrackingErrorAbs: 0.1,
  enableExposureGrouping: false,
  canonicalizeExposureGroups: false,
  canonicalizeOnlyInPhase: [],
  canonicalizeMaxNotionalPctPerRun: 0.1,
  canonicalizeMinDriftToAct: 0.05,
  canonicalizeOnlyIfAffordable: true,
  universeFile: '',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: false,
  requireApproval: false,
  optionsUnderlyings: ['IWM'],
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

const emptyPortfolio: PortfolioState = { cash: 1000, equity: 1000, holdings: [] };

describe('regime tilts influence deterministic baseline selection', () => {
  it('tilts toward small-cap in risk_on and toward duration in risk_off', async () => {
    const histories = {
      SPY: [100, 100.5], // weak momentum
      IWM: [100, 101.8], // stronger momentum
      TLT: [100, 101] // modest momentum
    };
    const md = new StubMarketData(histories);
    const riskOn: RegimeContext = {
      equityRegime: { label: 'risk_on', confidence: 0.8 },
      volRegime: { label: 'low', confidence: 0.6 },
      ratesRegime: { label: 'falling', stance: 'neutral', confidence: 0.5 },
      breadth: 'broad'
    };
    const riskOff: RegimeContext = {
      equityRegime: { label: 'risk_off', confidence: 0.4 },
      volRegime: { label: 'stressed', confidence: 0.8 },
      ratesRegime: { label: 'falling', stance: 'neutral', confidence: 0.5 },
      breadth: 'concentrated'
    };

    const resOn = await runDeterministicBaseline(asOf, ['SPY', 'IWM', 'TLT'], baseConfig, emptyPortfolio, md, riskOn);
    const resOff = await runDeterministicBaseline(asOf, ['SPY', 'IWM', 'TLT'], baseConfig, emptyPortfolio, md, riskOff);

    const buyOn = resOn.intent.orders.find((o) => o.side === 'BUY');
    const buyOff = resOff.intent.orders.find((o) => o.side === 'BUY');

    expect(buyOn?.symbol).toBe('IWM'); // risk_on tilt favors small-cap equity
    expect(buyOff?.symbol).toBe('TLT'); // risk_off + falling rates tilt favors duration
  });
});
