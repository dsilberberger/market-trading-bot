import { MarketDataProvider } from './marketData.types';
import { defaultMarketData, StubMarketDataProvider } from './marketData.stub';
import { ETradeMarketDataProvider } from './marketData.etrade';
import { ETradeClient } from '../integrations/etradeClient';
import { getStatus } from '../broker/etrade/authService';
import { Mode } from '../core/types';
import { resolveTokenStorePath } from '../integrations/etradeTokenStore';

export const getMarketDataProvider = (mode: Mode = 'paper'): MarketDataProvider => {
  // Default to real E*TRADE provider outside of tests/backtest unless explicitly overridden.
  const providerEnv = (process.env.MARKET_DATA_PROVIDER || '').toLowerCase();
  const provider = providerEnv || (process.env.NODE_ENV === 'test' || mode === 'backtest' ? 'stub' : 'etrade');
  if (mode === 'backtest' || process.env.NODE_ENV === 'test') {
    return defaultMarketData;
  }

  const useLiveInPaper = process.env.USE_LIVE_DATA_IN_PAPER === 'true';
  const env = (process.env.ETRADE_ENV as 'sandbox' | 'prod') || 'sandbox';
  const sandboxLive = env === 'sandbox' && process.env.USE_SANDBOX_MARKET_DATA === 'true';
  const shouldUseLive =
    provider === 'etrade' && (mode === 'live' || (mode === 'paper' && useLiveInPaper)) && (env === 'prod' || sandboxLive);

  if (provider === 'stub') {
    if (mode === 'paper' || mode === 'live') {
      console.warn('MARKET_DATA_PROVIDER=stub in live/paper; returning stub (healthchecks should fail closed).');
    }
    return defaultMarketData;
  }

  if (shouldUseLive) {
    const consumerKey = process.env.ETRADE_CONSUMER_KEY;
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) {
      throw new Error('E*TRADE keys missing; cannot use stub market data in live/paper mode.');
    }
    const status = getStatus();
    if (status.status !== 'ACTIVE') {
      throw new Error(`E*TRADE auth not active (${status.status}); market data unavailable for mode=${mode}.`);
    }
    const client = new ETradeClient({
      consumerKey,
      consumerSecret,
      env,
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: resolveTokenStorePath()
    });
    return new ETradeMarketDataProvider(client, client.getAuthStatus().env);
  }

  // Fallback: provider requested etrade but conditions not met (e.g., paper without useLive flag)
  console.warn('Falling back to stub market data (live provider not enabled for this mode/config).');
  return defaultMarketData;
};

export { StubMarketDataProvider };
