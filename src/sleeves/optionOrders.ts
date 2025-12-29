import { BotConfig } from '../core/types';

export interface OptionCandidate {
  symbol: string;
  expiry: string;
  strike: number;
  premium: number;
  type: 'PUT' | 'CALL';
}

export const buildBuyToOpenCall = (c: OptionCandidate, contracts: number, config: BotConfig) => {
  const limitBuffer = config.growth?.limitPriceBufferPct ?? 0.05;
  const limitPrice = c.premium * (1 + limitBuffer);
  return {
    orderType: 'EQO',
    action: 'BUY_TO_OPEN',
    quantity: contracts,
    limitPrice,
    optionSymbol: c.symbol,
    strike: c.strike,
    expiry: c.expiry,
    callPut: c.type,
    timeInForce: 'DAY'
  };
};

export const buildSellToCloseCall = (c: OptionCandidate, contracts: number, config: BotConfig) => {
  const limitBuffer = config.growth?.limitPriceBufferPct ?? 0.05;
  const limitPrice = c.premium ? c.premium * (1 - limitBuffer) : undefined;
  return {
    orderType: 'EQO',
    action: 'SELL_TO_CLOSE',
    quantity: contracts,
    limitPrice,
    optionSymbol: c.symbol,
    strike: c.strike,
    expiry: c.expiry,
    callPut: c.type,
    timeInForce: 'DAY'
  };
};

export const buildBuyToOpenPut = (c: OptionCandidate, contracts: number, config: BotConfig) => {
  const limitBuffer = config.insurance?.limitPriceBufferPct ?? 0.05;
  const limitPrice = c.premium * (1 + limitBuffer);
  return {
    orderType: 'EQO',
    action: 'BUY_TO_OPEN',
    quantity: contracts,
    limitPrice,
    optionSymbol: c.symbol,
    strike: c.strike,
    expiry: c.expiry,
    callPut: c.type,
    timeInForce: 'DAY'
  };
};

export const buildSellToClosePut = (c: OptionCandidate, contracts: number, config: BotConfig) => {
  const limitBuffer = config.insurance?.limitPriceBufferPct ?? 0.05;
  const limitPrice = c.premium ? c.premium * (1 - limitBuffer) : undefined;
  return {
    orderType: 'EQO',
    action: 'SELL_TO_CLOSE',
    quantity: contracts,
    limitPrice,
    optionSymbol: c.symbol,
    strike: c.strike,
    expiry: c.expiry,
    callPut: c.type,
    timeInForce: 'DAY'
  };
};
