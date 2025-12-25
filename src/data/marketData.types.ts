export interface PriceBar {
  date: string;
  close: number;
}

export interface Quote {
  symbol: string;
  price: number;
  asOf: string;
}

export interface MarketDataProvider {
  getQuote(symbol: string, asOf: string): Promise<Quote>;
  getHistory(symbol: string, asOf: string, lookbackDays: number): Promise<PriceBar[]>;
}
