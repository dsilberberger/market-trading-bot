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
  plannedAction: 'OPEN' | 'CLOSE' | 'HOLD' | 'NONE' | 'ROLL';
  order?: any;
  rollOrder?: any;
  reason?: string;
  reserveContext?: { reservePoolUsd: number; sleeveBudgetUsd: number; consumedUsd: number; availableUsd: number };
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

const defaultState: GrowthSleeveState = { status: 'INACTIVE' };
const DEFAULT_INITIAL_GROWTH_TRANCHE_PCT = 0.08;
const DEFAULT_MAX_TOTAL_GROWTH_PCT = 0.18;

const statePathForEnv = (env?: string, accountKey?: string) => {
  const override = process.env.GROWTH_STATE_PATH;
  if (override) return path.resolve(process.cwd(), override);
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
  const initialTranchePct = config.growth?.initialTranchePct ?? DEFAULT_INITIAL_GROWTH_TRANCHE_PCT;
  const maxTotalPct = config.growth?.maxTotalPct ?? DEFAULT_MAX_TOTAL_GROWTH_PCT;
  const spendPct = Math.min(config.growth?.spendPct ?? maxTotalPct, maxTotalPct);
  const reservePool = reservePoolUsd ?? reserveBudget ?? 0;
  const sleeveBudget = reservePool * spendPct;
  const relevantPositions = (optionPositions || []).filter((p) => p.type === 'CALL');
  const activeInsurancePosition = (optionPositions || []).some((p) => p.type === 'PUT' && (p.contracts || 0) > 0);
  const premiumForPosition = (p: OptionPositionSnapshot) => {
    const px = p.avgOpenPrice ?? p.marketPrice ?? 0;
    const mult = p.multiplier ?? 100;
    const contracts = p.contracts ?? 0;
    return px * mult * contracts;
  };
  const marketValueForPosition = (p: OptionPositionSnapshot) => {
    if (typeof p.marketValueUsd === 'number') return Math.max(0, p.marketValueUsd);
    const px = p.marketPrice ?? p.avgOpenPrice ?? 0;
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

  const buildOpenOrder = async (targetSpendUsd: number) => {
    const underlyingSel = selectOptionsUnderlying('GROWTH', config);
    if (!underlyingSel.symbol) {
      result.reason = 'No underlying available';
      return null;
    }
    const px = quotes[underlyingSel.symbol];
    if (!px || px <= 0) {
      result.reason = 'Underlying price unavailable';
      return null;
    }

    const contract = await selectGrowthContract(underlyingSel.symbol, asOf, px, config, chainProvider);
    if (!contract) {
      result.reason = 'No contract available';
      return null;
    }

    const perContractUsd = contract.premium * 100;
    const maxSpend = Math.max(
      0,
      Math.min(targetSpendUsd, availableReserve, cashAvailable !== undefined ? cashAvailable : targetSpendUsd)
    );
    const contracts = Math.floor(maxSpend / perContractUsd);
    if (contracts < 1) {
      result.reason = 'Budget insufficient for 1 contract';
      return null;
    }

    return {
      contract,
      contracts,
      notional: perContractUsd * contracts,
      order: buildBuyToOpenCall(contract, contracts, config)
    };
  };

  if (!arbitratorAllowed || activeInsurancePosition) {
    if (workingState.status === 'DEPLOYED' && !sameDay) {
      result.plannedAction = 'CLOSE';
      result.order = stateToCloseOrder(workingState, config);
      flags.push({
        code: activeInsurancePosition ? 'GROWTH_UNWIND_DUE_TO_INSURANCE' : 'GROWTH_UNWIND_DUE_TO_ARBITRATOR',
        severity: 'info',
        message: activeInsurancePosition ? 'Insurance active; unwind growth convexity.' : 'Regime weakened; unwind.'
      });
      workingState.status = 'UNWINDING';
    } else {
      result.reason = activeInsurancePosition ? 'Growth disabled while insurance is active' : 'Growth not allowed';
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
          const rollTargetSpendUsd = Math.min(
            sleeveBudget,
            Math.max(
              relevantPositions.reduce((sum, position) => sum + marketValueForPosition(position), 0),
              reservePool * initialTranchePct
            )
          );
          const roll = await buildOpenOrder(rollTargetSpendUsd);
          if (roll) {
            result.plannedAction = 'ROLL';
            result.order = stateToCloseOrder(workingState, config);
            result.rollOrder = roll.order;
            workingState.openedRunId = runId;
            workingState.openedAsOf = asOf;
            workingState.underlying = roll.contract.symbol;
            workingState.expiry = roll.contract.expiry;
            workingState.strike = roll.contract.strike;
            workingState.contracts = roll.contracts;
            workingState.premiumUSD = roll.notional;
            flags.push({
              code: 'GROWTH_ROLL_PLANNED',
              severity: 'info',
              message: 'Growth convexity rolled forward while robust risk_on persists.',
              observed: { targetSpendUsd: rollTargetSpendUsd, contracts: roll.contracts }
            });
          } else {
            result.plannedAction = 'HOLD';
          }
        }
      }
    }
    saveGrowthState(workingState, env, accountKey);
    return result;
  }

  const entryTargetSpendUsd = Math.min(reservePool * initialTranchePct, sleeveBudget);
  const open = await buildOpenOrder(entryTargetSpendUsd);
  if (!open) {
    saveGrowthState(workingState, env, accountKey);
    return result;
  }

  workingState.status = 'DEPLOYED';
  workingState.openedRunId = runId;
  workingState.openedAsOf = asOf;
  workingState.underlying = open.contract.symbol;
  workingState.expiry = open.contract.expiry;
  workingState.strike = open.contract.strike;
  workingState.contracts = open.contracts;
  workingState.premiumUSD = open.notional;

  result.plannedAction = 'OPEN';
  result.order = open.order;
  result.reserveContext = {
    ...result.reserveContext,
    reservePoolUsd: reservePool,
    sleeveBudgetUsd: sleeveBudget,
    consumedUsd: consumedReserve,
    availableUsd: availableReserve
  };
  result.flags.push({
    code: 'GROWTH_OPEN_PLANNED',
    severity: 'info',
    message: 'Growth convexity opening',
    observed: {
      notional: open.notional,
      contracts: open.contracts,
      underlying: open.contract.symbol,
      strike: open.contract.strike,
      expiry: open.contract.expiry
    }
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
