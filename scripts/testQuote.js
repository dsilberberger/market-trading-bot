require('dotenv/config');
const { ETradeClient } = require('../src/integrations/etradeClient');

(async () => {
  try {
    const c = new ETradeClient({
      consumerKey: process.env.ETRADE_CONSUMER_KEY,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET,
      env: process.env.ETRADE_ENV || 'prod',
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: process.env.ETRADE_TOKEN_STORE || process.env.TOKEN_STORE_PATH
    });
    const q = await c.getQuote('SPY');
    console.log('quote OK', q);
  } catch (err) {
    console.error('quote failed', (err && err.message) || err);
    process.exit(1);
  }
})();
