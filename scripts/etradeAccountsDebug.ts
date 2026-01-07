import { ETradeClient } from '../src/integrations/etradeClient';
import { resolveTokenStorePath } from '../src/integrations/etradeTokenStore';

(async () => {
  try {
    const env = (process.env.ETRADE_ENV || 'prod').toLowerCase();
    const ck = process.env.ETRADE_CONSUMER_KEY;
    const cs = process.env.ETRADE_CONSUMER_SECRET;
    if (!ck || !cs) throw new Error('keys missing');
    const client = new ETradeClient({
      consumerKey: ck,
      consumerSecret: cs,
      env: env as any,
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: resolveTokenStorePath()
    });
    const url = env === 'prod' ? 'https://api.etrade.com/v1/accounts/list.json' : 'https://apisb.etrade.com/v1/accounts/list.json';
    const resp = await client.signedFetch(url, 'GET');
    const text = await resp.text();
    console.log('status', resp.status, 'ok', resp.ok);
    console.log('body', text.slice(0, 2000));
  } catch (e: any) {
    console.error('ERR', e?.message || e);
  }
})();
