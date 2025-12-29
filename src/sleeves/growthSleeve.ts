import fs from 'fs';
import path from 'path';
import { BotConfig } from '../core/types';
import { selectOptionsUnderlying } from './optionsUnderlying';
import { OptionCandidate, buildBuyToOpenCall, buildSellToCloseCall } from './optionOrders';

export type GrowthPhase = 'INACTIVE' | 'DEPLOYED' | 'UNWINDING';

export interface GrowthSleeveState {
  status: GrowthPhase;
  openedRunId?: string;
  openedAsOf?: string;
  underlying?: string;
  strike?: number;
  expiry?: string;
  contracts?: number;
  premiumUSD?: number;
}

export interface OptionChainProvider {
  getCallCandidates: (symbol: string, asOf: string) => Promise<OptionCandidate[]>;
}

export interface GrowthPlanResult {
  state: GrowthSleeveState;
  plannedAction: 'OPEN' | 'CLOSE' | 'HOLD' | 'NONE';
  order?: any;
  reason?: string;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

const defaultState: GrowthSleeveState = { status: 'INACTIVE' };

const statePathForEnv = (env?: string, accountKey?: string) => {
  const fname = ['growth_state', env || 'default', accountKey || 'default'].join('.') + '.json';
  return path.resolve(process.cwd(), 'data_cache', fname);
};

export const loadGrowthState = (env?: string, accountKey?: string): GrowthSleeveState => {
  const p = statePathForEnv(env, accountKey);
  if (!fs.existsSync(p)) return { ...defaultState };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { ...defaultState };
  }
};

export const saveGrowthState = (state: GrowthSleeveState, env?: string, accountKey?: string) => {
  const p = statePathForEnv(env, accountKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
};

const syntheticPremium = (px: number, moneyness: number, bufferPct: number) => {
  const est = px * 0.03 * moneyness; // smaller premium for calls
  return est * (1 + bufferPct);
};

export const selectGrowthContract = async (
  symbol: string,
  asOf: string,
  price: number,
  config: BotConfig,
  chainProvider?: OptionChainProvider
): Promise<OptionCandidate | null> => {
  const minMonths = config.growth?.minMonths ?? 3;
  const maxMonths = config.growth?.maxMonths ?? 6;
  const minMoney = config.growth?.minMoneyness ?? 1.03;
  const maxMoney = config.growth?.maxMoneyness ?? 1.1;
  const buffer = config.growth?.limitPriceBufferPct ?? 0.05;

  if (!chainProvider) {
    const targetM = Math.min(Math.max(minMoney, 1.0), maxMoney);
    return {
      symbol,
      expiry: '',
      strike: price * targetM,
      premium: syntheticPremium(price, targetM, buffer),
      type: 'CALL'
    };
  }

  try {
    const chain = await chainProvider.getCallCandidates(symbol, asOf);
    const filtered = chain.filter((c) => {
      const expDate = new Date(c.expiry);
      const asOfDate = new Date(asOf);
      const months = (expDate.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
      const m = c.strike / price;
      return months >= minMonths && months <= maxMonths && m >= minMoney && m <= maxMoney;
    });
    if (!filtered.length) return null;
    return filtered.sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  } catch {
    return null;
  }
};

export interface GrowthPlannerInput {
  runId: string;
  asOf: string;
  config: BotConfig;
  arbitratorAllowed: boolean;
  reserveBudget: number;
  cashAvailable: number;
  quotes: Record<string, number>;
  chainProvider?: OptionChainProvider;
  env?: string;
  accountKey?: string;
}

export const planGrowthSleeve = async (input: GrowthPlannerInput): Promise<GrowthPlanResult> => {
  const {
    runId,
    asOf,
    config,
    arbitratorAllowed,
    reserveBudget,
    cashAvailable,
    quotes,
    chainProvider,
    env,
    accountKey
  } = input;
  const flags: GrowthPlanResult['flags'] = [];
  const state = loadGrowthState(env, accountKey);
  const spendPct = config.growth?.spendPct ?? 0.2;
  const budget = reserveBudget * spendPct;

  const sameDay = state.openedAsOf && state.openedAsOf.slice(0, 10) === asOf.slice(0, 10);
  const nearExpiryDays = config.growth?.closeWithinDays ?? 21;
  const allowExpire = config.growth?.allowExpire ?? false;

  const result: GrowthPlanResult = {
    state,
    plannedAction: 'NONE',
    flags
  };

  if (!arbitratorAllowed) {
    if (state.status === 'DEPLOYED' && !sameDay) {
      result.plannedAction = 'CLOSE';
      result.order = stateToCloseOrder(state, config);
      flags.push({ code: 'GROWTH_UNWIND_DUE_TO_ARBITRATOR', severity: 'info', message: 'Regime weakened; unwind.' });
      state.status = 'UNWINDING';
    } else {
      result.reason = 'Growth not allowed';
    }
    saveGrowthState(state, env, accountKey);
    return result;
  }

  if (state.status === 'DEPLOYED') {
    const expiryDate = state.expiry ? new Date(state.expiry) : undefined;
    const asOfDate = new Date(asOf);
    if (expiryDate) {
      const days = (expiryDate.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24);
      if (days <= nearExpiryDays && !sameDay) {
        if (allowExpire) {
          flags.push({ code: 'GROWTH_NEAR_EXPIRY', severity: 'info', message: 'Call near expiry; allow to expire.' });
          result.plannedAction = 'HOLD';
        } else {
          result.plannedAction = 'CLOSE';
          result.order = stateToCloseOrder(state, config);
          state.status = 'UNWINDING';
        }
      }
    }
    saveGrowthState(state, env, accountKey);
    return result;
  }

  // Plan open
  const underlyingSel = selectOptionsUnderlying('GROWTH', config);
  if (!underlyingSel.symbol) {
    result.reason = 'No underlying available';
    return result;
  }
  const px = quotes[underlyingSel.symbol];
  if (!px || px <= 0) {
    result.reason = 'Underlying price unavailable';
    return result;
  }

  const contract = await selectGrowthContract(underlyingSel.symbol, asOf, px, config, chainProvider);
  if (!contract) {
    result.reason = 'No contract available';
    return result;
  }
  const perContract = contract.premium;
  const maxSpend = Math.min(budget, cashAvailable);
  const contracts = Math.floor(maxSpend / perContract);
  if (contracts < 1) {
    result.reason = 'Budget insufficient for 1 contract';
    return result;
  }

  const notional = perContract * contracts;
  state.status = 'DEPLOYED';
  state.openedRunId = runId;
  state.openedAsOf = asOf;
  state.underlying = contract.symbol;
  state.expiry = contract.expiry;
  state.strike = contract.strike;
  state.contracts = contracts;
  state.premiumUSD = notional;

  result.plannedAction = 'OPEN';
  result.order = buildBuyToOpenCall(contract, contracts, config);
  result.flags.push({
    code: 'GROWTH_OPEN_PLANNED',
    severity: 'info',
    message: 'Growth convexity opening',
    observed: { notional, contracts, underlying: contract.symbol, strike: contract.strike, expiry: contract.expiry }
  });
  saveGrowthState(state, env, accountKey);
  return result;
};

const stateToCloseOrder = (state: GrowthSleeveState, config: BotConfig) => {
  if (!state.underlying || !state.contracts || !state.strike) return null;
  const contract: OptionCandidate = {
    symbol: state.underlying,
    expiry: state.expiry || '',
    strike: state.strike,
    premium: 0,
    type: 'CALL'
  };
  return buildSellToCloseCall(contract, state.contracts, config);
};
