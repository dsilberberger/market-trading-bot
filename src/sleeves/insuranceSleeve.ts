import fs from 'fs';
import path from 'path';
import { BotConfig } from '../core/types';
import { selectOptionsUnderlying } from './optionsUnderlying';
import { OptionCandidate, buildBuyToOpenPut, buildSellToClosePut } from './optionOrders';

export type InsurancePhase = 'INACTIVE' | 'DEPLOYED' | 'UNWINDING';

export interface InsuranceSleeveState {
  status: InsurancePhase;
  openedRunId?: string;
  openedAsOf?: string;
  underlying?: string;
  strike?: number;
  expiry?: string;
  contracts?: number;
  premiumUSD?: number;
}

export interface OptionChainProvider {
  getPutCandidates: (symbol: string, asOf: string) => Promise<OptionCandidate[]>;
}

export interface InsurancePlanResult {
  state: InsuranceSleeveState;
  plannedAction: 'OPEN' | 'CLOSE' | 'HOLD' | 'NONE';
  order?: any;
  reason?: string;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

const defaultState: InsuranceSleeveState = { status: 'INACTIVE' };

const statePathForEnv = (env?: string, accountKey?: string) => {
  const fname = ['insurance_state', env || 'default', accountKey || 'default'].join('.') + '.json';
  return path.resolve(process.cwd(), 'data_cache', fname);
};

export const loadInsuranceState = (env?: string, accountKey?: string): InsuranceSleeveState => {
  const p = statePathForEnv(env, accountKey);
  if (!fs.existsSync(p)) return { ...defaultState };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { ...defaultState };
  }
};

export const saveInsuranceState = (state: InsuranceSleeveState, env?: string, accountKey?: string) => {
  const p = statePathForEnv(env, accountKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
};

const syntheticPremium = (underlyingPx: number, moneyness: number, bufferPct: number) => {
  // crude premium estimate: 5% of underlying adjusted by moneyness
  const est = underlyingPx * 0.05 * (1 / moneyness);
  return est * (1 + bufferPct);
};

export const selectInsuranceContract = async (
  symbol: string,
  asOf: string,
  price: number,
  config: BotConfig,
  chainProvider?: OptionChainProvider
): Promise<OptionCandidate | null> => {
  const minMonths = config.insurance?.minMonths ?? 3;
  const maxMonths = config.insurance?.maxMonths ?? 6;
  const minMoney = config.insurance?.minMoneyness ?? 0.95;
  const maxMoney = config.insurance?.maxMoneyness ?? 1.0;
  const buffer = config.insurance?.limitPriceBufferPct ?? 0.05;

  if (!chainProvider) {
    const targetM = Math.min(Math.max(minMoney, 0.9), maxMoney);
    return {
      symbol,
      expiry: '', // unknown without chain; set empty
      strike: price * targetM,
      premium: syntheticPremium(price, targetM, buffer),
      type: 'PUT'
    };
  }

  try {
    const chain = await chainProvider.getPutCandidates(symbol, asOf);
    const filtered = chain.filter((c) => {
      const expDate = new Date(c.expiry);
      const asOfDate = new Date(asOf);
      const months = (expDate.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
      const m = c.strike / price;
      return months >= minMonths && months <= maxMonths && m >= minMoney && m <= maxMoney;
    });
    if (!filtered.length) return null;
    // pick lowest premium (closest ATM) for now
    return filtered.sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  } catch {
    return null;
  }
};

export interface InsurancePlannerInput {
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

export const planInsuranceSleeve = async (input: InsurancePlannerInput): Promise<InsurancePlanResult> => {
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
  const flags: InsurancePlanResult['flags'] = [];
  const state = loadInsuranceState(env, accountKey);
  const spendPct = config.insurance?.spendPct ?? 0.85;
  const budget = reserveBudget * spendPct;

  const sameDay = state.openedAsOf && state.openedAsOf.slice(0, 10) === asOf.slice(0, 10);
  const nearExpiryDays = config.insurance?.closeWithinDays ?? 21;
  const allowExpire = config.insurance?.allowExpire ?? false;

  const result: InsurancePlanResult = {
    state,
    plannedAction: 'NONE',
    flags
  };

  // If arbitrator blocks insurance
  if (!arbitratorAllowed) {
    if (state.status === 'DEPLOYED' && !sameDay) {
      result.plannedAction = 'CLOSE';
      result.order = stateToCloseOrder(state, config);
      flags.push({ code: 'INSURANCE_UNWIND_DUE_TO_ARBITRATOR', severity: 'info', message: 'Regime normalized; unwind.' });
      state.status = 'UNWINDING';
    } else {
      result.reason = 'Insurance not allowed';
    }
    saveInsuranceState(state, env, accountKey);
    return result;
  }

  // If already deployed
  if (state.status === 'DEPLOYED') {
    const expiryDate = state.expiry ? new Date(state.expiry) : undefined;
    const asOfDate = new Date(asOf);
    if (expiryDate) {
      const days = (expiryDate.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24);
      if (days <= nearExpiryDays && !sameDay) {
        if (allowExpire) {
          flags.push({ code: 'INSURANCE_NEAR_EXPIRY', severity: 'info', message: 'Option near expiry; allow to expire.' });
          result.plannedAction = 'HOLD';
        } else {
          result.plannedAction = 'CLOSE';
          result.order = stateToCloseOrder(state, config);
          state.status = 'UNWINDING';
        }
      }
    }
    saveInsuranceState(state, env, accountKey);
    return result;
  }

  // Plan open
  const underlyingSel = selectOptionsUnderlying('HEDGE', config);
  if (!underlyingSel.symbol) {
    result.reason = 'No underlying available';
    return result;
  }
  const px = quotes[underlyingSel.symbol];
  if (!px || px <= 0) {
    result.reason = 'Underlying price unavailable';
    return result;
  }

  const contract = await selectInsuranceContract(underlyingSel.symbol, asOf, px, config, chainProvider);
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
  result.order = buildBuyToOpenPut(contract, contracts, config);
  result.flags.push({
    code: 'INSURANCE_OPEN_PLANNED',
    severity: 'info',
    message: 'Insurance sleeve opening',
    observed: { notional, contracts, underlying: contract.symbol, strike: contract.strike, expiry: contract.expiry }
  });
  saveInsuranceState(state, env, accountKey);
  return result;
};

const stateToCloseOrder = (state: InsuranceSleeveState, config: BotConfig) => {
  if (!state.underlying || !state.contracts || !state.strike) return null;
  const contract: OptionCandidate = {
    symbol: state.underlying,
    expiry: state.expiry || '',
    strike: state.strike,
    premium: 0,
    type: 'PUT'
  };
  return buildSellToClosePut(contract, state.contracts, config);
};
