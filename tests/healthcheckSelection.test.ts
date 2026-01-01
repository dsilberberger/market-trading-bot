import { marketDataHealthcheck } from '../scripts/healthcheck';

describe('marketDataHealthcheck provider selection', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fails closed in paper mode when MARKET_DATA_PROVIDER=stub (non-test env)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MARKET_DATA_PROVIDER = 'stub';
    const res = await marketDataHealthcheck(['SPY'], 'paper');
    expect(res.ok).toBe(false);
    expect(res.providerName).toBe('STUB');
    expect(res.usedStub).toBe(true);
    expect(res.errors).toContain('market data provider is stubbed in live/paper; refusing to pass healthcheck');
    const sym = res.perSymbol['SPY'];
    expect(sym.status).toBe('NOT_FOUND');
    expect(sym.valueUsed).toBeUndefined();
    expect(sym.quoteQuality).toBe('STUB');
  });

  it('passes in harness mode using stubbed data', async () => {
    process.env.NODE_ENV = 'test';
    const res = await marketDataHealthcheck(['SPY'], 'harness');
    expect(res.ok).toBe(true);
    expect(res.providerName).toBe('STUB');
    expect(res.usedStub).toBe(true);
    const sym = res.perSymbol['SPY'];
    expect(sym.status).toBe('FOUND');
    expect(sym.quoteQuality).toBe('STUB');
    expect(typeof sym.valueUsed).toBe('number');
  });
});

