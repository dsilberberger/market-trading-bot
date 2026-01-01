import fs from 'fs';
import path from 'path';
import { BotConfig } from '../core/types';
import { selectOptionsUnderlying } from './optionsUnderlying';
import { OptionCandidate, buildBuyToOpenCall, buildSellToCloseCall } from './optionOrders';

export interface OptionPositionSnapshot {
  underlying: string | null;
  optionSymbol: string | null;
  type: 'CALL' | 'PUT' | null;
  strike: number | null;
  expiry: string | null;
  contracts: number | null;
  multiplier: number | null;
  avgOpenPrice: number | null;
  openDate: string | null;
  marketPrice: number | null;
  marketValueUsd: number | null;
  unrealizedPnlUsd: number | null;
}

export interface OptionMarkSnapshot {
  positionId: string;
  underlying: string | null;
  type: 'CALL' | 'PUT' | null;
  strike: number | null;
  expiry: string | null;
  daysToExpiry: number | null;
  marketPrice: number | null;
  marketValueUsd: number | null;
  estimatedMark: number | null;
}

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
  reserveContext?: { reservePoolUsd: number; sleeveBudgetUsd: number; consumedUsd: number; availableUsd: number };
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
  reserveBudget?: number;
  reservePoolUsd?: number;
  cashAvailable?: number;
  quotes: Record<string, number>;
  optionPositions?: OptionPositionSnapshot[];
  optionMarks?: OptionMarkSnapshot[];
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
    reservePoolUsd,
    cashAvailable,
    quotes,
    optionPositions,
    optionMarks,
    chainProvider,
    env,
    accountKey
  } = input;
  const flags: GrowthPlanResult['flags'] = [];
  const state = loadGrowthState(env, accountKey);
  const spendPct = config.growth?.spendPct ?? 0.2;
  const reservePool = reservePoolUsd ?? reserveBudget ?? 0;
  const sleeveBudget = reservePool * spendPct;
  const relevantPositions = (optionPositions || []).filter((p) => p.type === 'CALL');
  const premiumForPosition = (p: OptionPositionSnapshot) => {
    const px = p.avgOpenPrice ?? p.marketPrice ?? 0;
    const mult = p.multiplier ?? 100;
    const contracts = p.contracts ?? 0;
    return px * mult * contracts;
  };
  const consumedReserve = relevantPositions.reduce((acc, p) => acc + premiumForPosition(p), 0);
  const availableReserve = Math.max(0, sleeveBudget - consumedReserve);

  const sameDay = state.openedAsOf && state.openedAsOf.slice(0, 10) === asOf.slice(0, 10);
  const nearExpiryDays = config.growth?.closeWithinDays ?? 21;
  const allowExpire = config.growth?.allowExpire ?? false;

  const findMark = (p: OptionPositionSnapshot): OptionMarkSnapshot | undefined => {
    const id = `${p.underlying || 'UNK'}:${p.type || 'UNK'}:${p.strike || 'UNK'}:${p.expiry || 'UNK'}`;
    return (optionMarks || []).find((m) => m.positionId === id);
  };

  const deriveStateFromPositions = (): GrowthSleeveState => {
    if (!relevantPositions.length) return state;
    const p = relevantPositions[0];
    return {
      status: 'DEPLOYED',
      openedRunId: state.openedRunId,
      openedAsOf: state.openedAsOf,
      underlying: p.underlying || undefined,
      strike: p.strike || undefined,
      expiry: p.expiry || undefined,
      contracts: p.contracts || undefined,
      premiumUSD: premiumForPosition(p) || undefined
    };
  };

  const workingState = state.status === 'INACTIVE' && relevantPositions.length ? deriveStateFromPositions() : state;

  const result: GrowthPlanResult = {
    state: workingState,
    plannedAction: 'NONE',
    flags,
    reserveContext: { reservePoolUsd: reservePool, sleeveBudgetUsd: sleeveBudget, consumedUsd: consumedReserve, availableUsd: availableReserve }
  };

  if (!arbitratorAllowed) {
    if (workingState.status === 'DEPLOYED' && !sameDay) {
      result.plannedAction = 'CLOSE';
      result.order = stateToCloseOrder(workingState, config);
      flags.push({ code: 'GROWTH_UNWIND_DUE_TO_ARBITRATOR', severity: 'info', message: 'Regime weakened; unwind.' });
      workingState.status = 'UNWINDING';
    } else {
      result.reason = 'Growth not allowed';
    }
    saveGrowthState(workingState, env, accountKey);
    return result;
  }

  if (workingState.status === 'DEPLOYED') {
    const expiryDate = workingState.expiry ? new Date(workingState.expiry) : undefined;
    const asOfDate = new Date(asOf);
    const mark = relevantPositions.length ? findMark(relevantPositions[0]) : undefined;
    const dteFromMark = mark?.daysToExpiry ?? null;
    const daysOverride = dteFromMark !== null && dteFromMark !== undefined ? dteFromMark : undefined;
    if (expiryDate) {
      const daysCalc = (expiryDate.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24);
      const days = daysOverride ?? daysCalc;
      if (days <= nearExpiryDays && !sameDay) {
        if (allowExpire) {
          flags.push({ code: 'GROWTH_NEAR_EXPIRY', severity: 'info', message: 'Call near expiry; allow to expire.' });
          result.plannedAction = 'HOLD';
        } else {
          result.plannedAction = 'CLOSE';
          result.order = stateToCloseOrder(workingState, config);
          workingState.status = 'UNWINDING';
        }
      }
    }
    saveGrowthState(workingState, env, accountKey);
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
  const maxSpend = cashAvailable !== undefined ? Math.min(availableReserve, cashAvailable) : availableReserve;
  const contracts = Math.floor(maxSpend / perContract);
  if (contracts < 1) {
    result.reason = 'Budget insufficient for 1 contract';
    return result;
  }

  const notional = perContract * contracts;
  workingState.status = 'DEPLOYED';
  workingState.openedRunId = runId;
  workingState.openedAsOf = asOf;
  workingState.underlying = contract.symbol;
  workingState.expiry = contract.expiry;
  workingState.strike = contract.strike;
  workingState.contracts = contracts;
  workingState.premiumUSD = notional;

  result.plannedAction = 'OPEN';
  result.order = buildBuyToOpenCall(contract, contracts, config);
  result.flags.push({
    code: 'GROWTH_OPEN_PLANNED',
    severity: 'info',
    message: 'Growth convexity opening',
    observed: { notional, contracts, underlying: contract.symbol, strike: contract.strike, expiry: contract.expiry }
  });
  saveGrowthState(workingState, env, accountKey);
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
