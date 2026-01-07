import { MarketDataProvider, PriceBar, Quote } from './marketData.types';
import { hashString, mulberry32 } from '../core/utils';

// Static price anchors for universe + proxies to make stub runs more realistic/repeatable.
const priceOverrides: Record<string, number> = {
  // New core universe
  VTI: 338.81,
  VXUS: 77.35,
  VTV: 194.63,
  USMV: 93.97,
  SHY: 82.89,
  IEF: 96.37,
  TIP: 110.16,
  ITOT: 150.25,
  SCHB: 26.5,
  IXUS: 86.78,
  SCHV: 30.17,
  IWD: 214.59,
  SPLV: 71.3,
  VGSH: 58.78,
  SCHO: 24.38,
  SCHR: 25.115,
  VGIT: 60.02,
  SCHP: 26.55,
  VTIP: 49.5,
  // Legacy universe (kept for tests/compat)
  SPY: 475,
  QQQ: 405,
  IWM: 195,
  EFA: 75,
  EEM: 40,
  TLT: 95,
  GLD: 190,
  // Proxies
  SPLG: 50,
  IVV: 475,
  VOO: 470,
  QQQM: 160,
  VTWO: 75,
  IJR: 110,
  IEFA: 70,
  IEMG: 52,
  VWO: 41,
  VGLT: 90,
  IAU: 37,
  GLDM: 19,
  SGOL: 18,
  BIL: 91,
  SGOV: 100,
  SHV: 90
};

const basePriceForSymbol = (symbol: string): number => {
  if (priceOverrides[symbol] !== undefined) return priceOverrides[symbol];
  const seed = hashString(symbol);
  const rng = mulberry32(seed);
  return 50 + rng() * 150;
};

const drift = (symbol: string): number => {
  const seed = hashString(symbol + 'drift');
  const rng = mulberry32(seed);
  return rng() * 0.06 - 0.03; // -3% to +3% drift
};

const priceForDate = (symbol: string, asOf: string): number => {
  const base = basePriceForSymbol(symbol);
  const seed = hashString(`${symbol}-${asOf}`);
  const rng = mulberry32(seed);
  const noise = (rng() - 0.5) * 0.02; // +/-1% noise
  return Math.max(1, base * (1 + drift(symbol) + noise));
};

export class StubMarketDataProvider implements MarketDataProvider {
  async getQuote(symbol: string, asOf: string): Promise<Quote> {
    return { symbol, price: priceForDate(symbol, asOf), asOf };
  }

  async getHistory(symbol: string, asOf: string, lookbackDays: number): Promise<PriceBar[]> {
    const bars: PriceBar[] = [];
    for (let i = lookbackDays; i >= 0; i -= 7) {
      const date = new Date(asOf);
      date.setDate(date.getDate() - i);
      const day = date.toISOString().slice(0, 10);
      bars.push({ date: day, close: priceForDate(symbol, day) });
    }
    return bars;
  }
}

export const defaultMarketData = new StubMarketDataProvider();
