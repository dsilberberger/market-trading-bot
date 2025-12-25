import { BotConfig, Mode } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';
import { StubBroker } from './broker.stub';
import { ETradeBroker } from './etrade/etradeBroker';
import { ETradeClient } from '../integrations/etradeClient';
import { resolveTokenStorePath } from '../integrations/etradeTokenStore';
import { getStatus } from './etrade/authService';

export const getBroker = (config: BotConfig, marketData: MarketDataProvider, mode: Mode = 'paper') => {
  const provider = (process.env.BROKER_PROVIDER || 'stub').toLowerCase();
  const consumerKey = process.env.ETRADE_CONSUMER_KEY;
  const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
  if (provider === 'etrade' && mode === 'live') {
    if (!consumerKey || !consumerSecret) {
      console.warn('BROKER_PROVIDER=etrade but E*TRADE keys missing; falling back to stub broker.');
      return new StubBroker(config, marketData);
    }
    const status = getStatus();
    if (status.status !== 'ACTIVE') {
      console.warn(`E*TRADE auth not active (${status.status}); using stub broker.`);
      return new StubBroker(config, marketData);
    }
    const client = new ETradeClient({
      consumerKey,
      consumerSecret,
      env: (process.env.ETRADE_ENV as 'sandbox' | 'prod') || 'sandbox',
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: resolveTokenStorePath()
    });
    return new ETradeBroker(config, marketData, client);
  }
  return new StubBroker(config, marketData);
};

export { StubBroker, ETradeBroker };
