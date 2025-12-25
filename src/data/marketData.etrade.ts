import { MarketDataProvider, PriceBar, Quote } from './marketData.types';
import { ETradeClient } from '../integrations/etradeClient';
import { StubMarketDataProvider } from './marketData.stub';

const baseApi = (env: string) => (env === 'prod' ? 'https://api.etrade.com' : 'https://apisb.etrade.com');
const isStubEnv = () => (process.env.MARKET_DATA_PROVIDER || 'stub').toLowerCase() === 'stub';

export class ETradeMarketDataProvider implements MarketDataProvider {
  private client: ETradeClient;
  private env: string;
  private delegate: StubMarketDataProvider;

  constructor(client: ETradeClient, env: string) {
    this.client = client;
    this.env = env;
    this.delegate = new StubMarketDataProvider();
  }

  async getQuote(symbol: string, asOf: string): Promise<Quote> {
    if (isStubEnv()) return this.delegate.getQuote(symbol, asOf);
    const url = `${baseApi(this.env)}/v1/market/quote/${encodeURIComponent(symbol)}.json`;
    try {
      const resp = await this.client.signedFetch(url, 'GET', { params: { detailFlag: 'ALL' } });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`E*TRADE quote failed: ${resp.status} ${text}`);
      }
      const json: any = await resp.json();
      const qd = json?.QuoteResponse?.QuoteData?.[0];
      const all = qd?.All || {};
      const candidates = [
        all.lastTrade,
        all.lastPrice,
        all.close,
        all.previousClose,
        all.ask,
        all.bid,
        qd?.Product?.all?.lastTrade
      ];
      const parsed = candidates.map((v) => Number(v) || 0).find((v) => v > 0) || 0;
      if (parsed > 0) {
        return { symbol, price: parsed, asOf };
      }
      const rawAll = JSON.stringify(all)?.slice(0, 400);
      throw new Error(`Quote missing price; All=${rawAll}`);
    } catch (err) {
      console.warn(`E*TRADE quote fallback for ${symbol}: ${(err as Error).message}`);
      // Return zero price so callers can detect missing quote instead of silently using stub values.
      return { symbol, price: 0, asOf };
    }
  }

  async getHistory(symbol: string, asOf: string, lookbackDays: number): Promise<PriceBar[]> {
    if (isStubEnv()) return this.delegate.getHistory(symbol, asOf, lookbackDays);
    try {
      const url = `${baseApi(this.env)}/v1/market/quote/${encodeURIComponent(symbol)}.json`;
      const resp = await this.client.signedFetch(url, 'GET', { params: { detailFlag: 'ALL' } });
      if (!resp.ok) throw new Error(`history quote ${resp.status}`);
      const json: any = await resp.json();
      const last = json?.QuoteResponse?.QuoteData?.[0]?.All;
      const lastPrice = Number(last?.lastTrade ?? last?.lastPrice ?? 0);
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) throw new Error('missing lastPrice');
      const stubSeries = await this.delegate.getHistory(symbol, asOf, lookbackDays);
      const lastStub = stubSeries.at(-1)?.close ?? lastPrice;
      const scale = lastStub ? lastPrice / lastStub : 1;
      const adjusted = stubSeries.map((bar) => ({ ...bar, close: Math.max(0.01, bar.close * scale) }));
      const uniqueCloses = new Set(adjusted.map((b) => Number(b.close.toFixed(4)))).size;
      if (uniqueCloses < 5) throw new Error('synthetic history too flat');
      return adjusted;
    } catch (err) {
      console.warn(`E*TRADE history fallback to stub for ${symbol}: ${(err as Error).message}`);
      return this.delegate.getHistory(symbol, asOf, lookbackDays);
    }
  }
}
