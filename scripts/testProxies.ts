import 'dotenv/config';
import { ETradeClient } from '../src/integrations/etradeClient';

const syms = ['SPYM', 'SPLG', 'IVV', 'VOO'];

const baseApi = (env: string) => (env === 'prod' ? 'https://api.etrade.com' : 'https://apisb.etrade.com');

const run = async () => {
  try {
    const client = new ETradeClient({
      consumerKey: process.env.ETRADE_CONSUMER_KEY || '',
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET || '',
      env: (process.env.ETRADE_ENV as 'prod' | 'sandbox') || 'prod',
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: process.env.ETRADE_TOKEN_STORE || process.env.TOKEN_STORE_PATH
    });
    for (const sym of syms) {
      const url = `${baseApi((process.env.ETRADE_ENV || 'prod').toLowerCase())}/v1/market/quote/${encodeURIComponent(
        sym
      )}.json`;
      try {
        const resp = await client.signedFetch(url, 'GET', { params: { detailFlag: 'ALL' } });
        const text = await resp.text();
        console.log(sym, 'HTTP', resp.status, 'body', text.slice(0, 200));
      } catch (err) {
        console.log(sym, 'error', (err as Error).message);
      }
    }
  } catch (err) {
    console.error('failed', (err as Error).message);
    process.exit(1);
  }
};

run();
