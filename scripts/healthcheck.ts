/* eslint-disable no-console */
import { performance } from 'perf_hooks';

type QuoteResult = {
  ok: boolean;
  timestamp: string;
  latencyMs: number;
  requestSymbols: string[];
  perSymbol: Record<
    string,
    {
      status: 'FOUND' | 'NOT_FOUND' | 'ERROR';
      fieldUsed?: string;
      valueUsed?: number;
      quoteQuality?: 'OK' | 'STALE' | 'MISSING' | 'FALLBACK';
      error?: string;
    }
  >;
  errors: string[];
};

// Harness stubbed quote fetch; replace with real E*TRADE client when wired.
const fetchQuotes = async (symbols: string[]) => {
  const out: Record<string, { status: 'FOUND' | 'NOT_FOUND'; last?: number }> = {};
  symbols.forEach((s) => {
    const seed = s === 'QQQ' ? 110 : s === 'TLT' ? 85 : s === 'IWM' || s === 'DIA' ? 95 : s === 'QQQM' || s === 'SPYM' ? 45 : 100;
    out[s] = { status: 'FOUND', last: seed };
  });
  return out;
};

export const marketDataHealthcheck = async (symbols: string[]): Promise<QuoteResult> => {
  const start = performance.now();
  const now = new Date().toISOString();
  const perSymbol: QuoteResult['perSymbol'] = {};
  const errors: string[] = [];
  let ok = false;
  try {
    const resp = await fetchQuotes(symbols);
    Object.entries(resp).forEach(([sym, r]) => {
      if (r.status === 'FOUND' && typeof r.last === 'number') {
        perSymbol[sym] = { status: 'FOUND', fieldUsed: 'last', valueUsed: r.last, quoteQuality: 'OK' };
      } else {
        perSymbol[sym] = { status: 'NOT_FOUND', quoteQuality: 'MISSING' };
      }
    });
    ok = Object.values(perSymbol).some((v) => v.status === 'FOUND');
  } catch (e: any) {
    errors.push(String(e?.message || e));
  }
  const latencyMs = performance.now() - start;
  return { ok, timestamp: now, latencyMs, requestSymbols: symbols, perSymbol, errors };
};

if (require.main === module) {
  const symbols = ['SPY', 'QQQ', 'TLT', 'SPYM', 'QQQM', 'IWM', 'DIA'];
  marketDataHealthcheck(symbols).then((res) => console.log(JSON.stringify(res, null, 2)));
}
