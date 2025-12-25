require('dotenv/config');
const { ETradeClient } = require('../src/integrations/etradeClient');

(async () => {
  try {
    const client = new ETradeClient({
      consumerKey: process.env.ETRADE_CONSUMER_KEY,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET,
      env: (process.env.ETRADE_ENV || 'sandbox'),
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: process.env.ETRADE_TOKEN_STORE || process.env.TOKEN_STORE_PATH
    });
    const token = client.getAccessToken?.();
    if (!token) {
      throw new Error('No access token found. Run auth:connect first.');
    }
    const url = `${(process.env.ETRADE_ENV || 'sandbox').toLowerCase() === 'prod' ? 'https://api.etrade.com' : 'https://apisb.etrade.com'}/v1/market/quote/SPY.json`;
    const resp = await client.signedFetch(url, 'GET');
    const text = await resp.text();
    console.log('HTTP', resp.status);
    console.log(text.slice(0, 500));
  } catch (err) {
    console.error('quote failed', (err && err.message) || err);
    process.exit(1);
  }
})();
