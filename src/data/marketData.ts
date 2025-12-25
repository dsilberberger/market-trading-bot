import { MarketDataProvider } from './marketData.types';
import { defaultMarketData, StubMarketDataProvider } from './marketData.stub';
import { ETradeMarketDataProvider } from './marketData.etrade';
import { ETradeClient } from '../integrations/etradeClient';
import { getStatus } from '../broker/etrade/authService';
import { Mode } from '../core/types';
import { resolveTokenStorePath } from '../integrations/etradeTokenStore';

export const getMarketDataProvider = (mode: Mode = 'paper'): MarketDataProvider => {
  const provider = (process.env.MARKET_DATA_PROVIDER || 'stub').toLowerCase();
  const useLiveInPaper = process.env.USE_LIVE_DATA_IN_PAPER === 'true';
  const env = (process.env.ETRADE_ENV as 'sandbox' | 'prod') || 'sandbox';
  const sandboxLive = env === 'sandbox' && process.env.USE_SANDBOX_MARKET_DATA === 'true';
  const shouldUseLive =
    provider === 'etrade' && (mode === 'live' || (mode === 'paper' && useLiveInPaper)) && (env === 'prod' || sandboxLive);
  if (shouldUseLive) {
    const consumerKey = process.env.ETRADE_CONSUMER_KEY;
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) {
      console.warn('MARKET_DATA_PROVIDER=etrade but E*TRADE keys missing; using stub market data.');
      return defaultMarketData;
    }
    const status = getStatus();
    if (status.status !== 'ACTIVE') {
      if (mode === 'live') {
        throw new Error(`E*TRADE auth not active (${status.status}); live market data unavailable.`);
      }
      console.warn(`E*TRADE auth not active (${status.status}); using stub market data.`);
      return defaultMarketData;
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
  if (provider === 'etrade' && env === 'sandbox' && !sandboxLive) {
    console.warn('ETRADE_ENV=sandbox and USE_SANDBOX_MARKET_DATA not true; using stub market data to avoid placeholder prices.');
  }
  return defaultMarketData;
};

export { StubMarketDataProvider };
