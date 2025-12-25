import path from 'path';

export const resolveTokenStorePath = () => {
  const env = (process.env.ETRADE_ENV || 'sandbox').toLowerCase();
  const base = process.env.TOKEN_STORE_PATH || process.env.ETRADE_TOKEN_STORE;
  if (base) return base;
  const suffix = env === 'prod' ? 'prod' : 'sandbox';
  return path.resolve(process.cwd(), `.secrets/etrade_tokens.${suffix}.json`);
};
