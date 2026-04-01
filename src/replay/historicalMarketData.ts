import { MarketDataProvider, PriceBar, Quote } from '../data/marketData.types';

export interface HistoricalReplayBar {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
}

const asDateOnly = (asOf: string) => (asOf.includes('T') ? asOf.slice(0, 10) : asOf);

const dayValue = (date: string) => new Date(`${date}T00:00:00Z`).getTime();

const normalizeBars = (bars: HistoricalReplayBar[]): PriceBar[] =>
  [...bars]
    .filter((bar) => bar && typeof bar.close === 'number' && Number.isFinite(bar.close) && bar.date)
    .sort((a, b) => dayValue(a.date) - dayValue(b.date))
    .map((bar) => ({ date: bar.date, close: bar.close }));

export class HistoricalMarketDataProvider implements MarketDataProvider {
  private readonly series: Record<string, PriceBar[]>;

  constructor(series: Record<string, HistoricalReplayBar[]>) {
    this.series = Object.fromEntries(Object.entries(series).map(([symbol, bars]) => [symbol, normalizeBars(bars || [])]));
  }

  getSeries(symbol: string): PriceBar[] {
    return [...(this.series[symbol] || [])];
  }

  getAvailableDates(symbol: string, start: string, end: string): string[] {
    const startValue = dayValue(start);
    const endValue = dayValue(end);
    return (this.series[symbol] || [])
      .filter((bar) => {
        const value = dayValue(bar.date);
        return value >= startValue && value <= endValue;
      })
      .map((bar) => bar.date);
  }

  async getQuote(symbol: string, asOf: string): Promise<Quote> {
    const bars = this.series[symbol] || [];
    const cutoff = dayValue(asDateOnly(asOf));
    const bar = [...bars].reverse().find((entry) => dayValue(entry.date) <= cutoff);
    if (!bar) {
      throw new Error(`No quote history available for ${symbol} at ${asOf}`);
    }
    return { symbol, price: bar.close, asOf };
  }

  async getHistory(symbol: string, asOf: string, lookbackDays: number): Promise<PriceBar[]> {
    const bars = this.series[symbol] || [];
    const cutoff = dayValue(asDateOnly(asOf));
    const minValue = cutoff - Math.max(0, lookbackDays) * 24 * 60 * 60 * 1000;
    return bars.filter((entry) => {
      const value = dayValue(entry.date);
      return value <= cutoff && value >= minValue;
    });
  }
}
