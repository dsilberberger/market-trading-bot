/* eslint-disable no-console */
import { performance } from 'perf_hooks';
import { getMarketDataProvider, StubMarketDataProvider } from '../src/data/marketData';
import { Mode } from '../src/core/types';

type QuoteResult = {
  ok: boolean;
  timestamp: string;
  latencyMs: number;
  providerName?: string;
  usedStub?: boolean;
  requestSymbols: string[];
  perSymbol: Record<
    string,
    {
      status: 'FOUND' | 'NOT_FOUND' | 'ERROR';
      fieldUsed?: string;
      valueUsed?: number;
      quoteQuality?: 'OK' | 'STALE' | 'MISSING' | 'FALLBACK' | 'STUB';
      error?: string;
      source?: string;
    }
  >;
  errors: string[];
};

type HealthcheckMode = Mode | 'harness';

// Harness-only stubbed quote fetch for tests; never used in production runs.
const fetchQuotesStub = async (symbols: string[]) => {
  const out: Record<string, { status: 'FOUND' | 'NOT_FOUND'; last?: number }> = {};
  symbols.forEach((s) => {
    const seed = s === 'QQQ' ? 110 : s === 'TLT' ? 85 : s === 'IWM' || s === 'DIA' ? 95 : s === 'QQQM' || s === 'SPYM' ? 45 : 100;
    out[s] = { status: 'FOUND', last: seed };
  });
  return out;
};

export const marketDataHealthcheck = async (
  symbols: string[],
  mode: HealthcheckMode = (process.env.NODE_ENV === 'test' ? 'harness' : 'paper')
): Promise<QuoteResult> => {
  const start = performance.now();
  const now = new Date().toISOString();
  const perSymbol: QuoteResult['perSymbol'] = {};
  const errors: string[] = [];
  let ok = false;
  let providerName = '';
  let usedStub = false;
  try {
    const useStub = mode === 'harness' || process.env.NODE_ENV === 'test';
    if (useStub) {
      const resp = await fetchQuotesStub(symbols);
      Object.entries(resp).forEach(([sym, r]) => {
        if (r.status === 'FOUND' && typeof r.last === 'number') {
          perSymbol[sym] = { status: 'FOUND', fieldUsed: 'last', valueUsed: r.last, quoteQuality: 'STUB', source: 'STUB' as any };
        } else {
          perSymbol[sym] = { status: 'NOT_FOUND', quoteQuality: 'STUB', source: 'STUB' as any };
        }
      });
      providerName = 'STUB';
      usedStub = true;
      ok = Object.values(perSymbol).some((v) => v.status === 'FOUND');
    } else {
      const provider = getMarketDataProvider(mode === 'live' ? 'live' : 'paper');
      const isStubProvider = provider instanceof StubMarketDataProvider;
      providerName = isStubProvider ? 'STUB' : 'ETRADE_QUOTE_API';
      usedStub = isStubProvider;
      if (isStubProvider) {
        errors.push('market data provider is stubbed in live/paper; refusing to pass healthcheck');
      }
      if (isStubProvider) {
        symbols.forEach((sym) => {
          perSymbol[sym] = {
            status: 'NOT_FOUND',
            quoteQuality: 'STUB',
            fieldUsed: null as any,
            valueUsed: undefined,
            error: 'provider stubbed'
          };
        });
        ok = false;
      } else {
        for (const sym of symbols) {
          const quote = await provider.getQuote(sym, now);
          const price = Number(quote?.price ?? 0);
          if (price > 0) {
            perSymbol[sym] = { status: 'FOUND', fieldUsed: 'price', valueUsed: price, quoteQuality: 'OK' };
          } else {
            perSymbol[sym] = {
              status: 'NOT_FOUND',
              quoteQuality: 'MISSING',
              fieldUsed: 'price',
              valueUsed: undefined
            };
          }
        }
        ok = Object.values(perSymbol).some((v) => v.status === 'FOUND');
      }
    }
  } catch (e: any) {
    errors.push(String(e?.message || e));
  }
  const latencyMs = performance.now() - start;
  return { ok, timestamp: now, latencyMs, providerName, usedStub, requestSymbols: symbols, perSymbol, errors };
};

if (require.main === module) {
  const symbols = ['SPY', 'QQQ', 'TLT', 'SPYM', 'QQQM', 'IWM', 'DIA'];
  marketDataHealthcheck(symbols).then((res) => console.log(JSON.stringify(res, null, 2)));
}
