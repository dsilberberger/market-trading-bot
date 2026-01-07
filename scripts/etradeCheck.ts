/**
 * Helper script to fetch E*TRADE account list and print balances/positions.
 * Uses env vars from .env:
 *   ETRADE_CONSUMER_KEY, ETRADE_CONSUMER_SECRET, ETRADE_ENV (prod/sandbox)
 *   ETRADE_CALLBACK_URL (if needed), ETRADE_TOKEN_STORE (optional)
 *
 * Usage:
 *   ETRADE_ENV=prod USE_ETRADE_ORDERS=true npx ts-node --transpile-only --compiler-options '{"module":"commonjs","moduleResolution":"node"}' scripts/etradeCheck.ts
 */
import { ETradeClient } from '../src/integrations/etradeClient';
import { resolveTokenStorePath } from '../src/integrations/etradeTokenStore';

const main = async () => {
  try {
    const env = (process.env.ETRADE_ENV || 'prod').toLowerCase() as 'prod' | 'sandbox';
    const consumerKey = process.env.ETRADE_CONSUMER_KEY;
    const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) throw new Error('E*TRADE keys missing');
    const client = new ETradeClient({
      consumerKey,
      consumerSecret,
      env,
      callbackUrl: process.env.ETRADE_CALLBACK_URL,
      tokenStorePath: resolveTokenStorePath()
    });
    const accounts = await client.getAccountList();
    console.log('Accounts:', JSON.stringify(accounts, null, 2));
    if (accounts?.AccountListResponse?.Accounts?.Account?.length) {
      const acct = accounts.AccountListResponse.Accounts.Account[0];
      console.log('Using accountIdKey:', acct.accountIdKey);
      const portfolio = await client.getPortfolio(acct.accountIdKey);
      console.log('Portfolio:', JSON.stringify(portfolio, null, 2));
    }
  } catch (e: any) {
    console.error('ERR', e?.message || e);
  }
};

main();
