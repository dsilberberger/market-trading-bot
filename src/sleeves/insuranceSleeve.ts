import fs from 'fs';
import path from 'path';
import { BotConfig, RegimeContext } from '../core/types';
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
  activeEpisodeId?: string;
  stagedEntryCount?: number;
  consecutiveStressSteps?: number;
  consecutiveNormalizationSteps?: number;
  lastEntryAsOf?: string;
}

export interface OptionChainProvider {
  getPutCandidates: (symbol: string, asOf: string) => Promise<OptionCandidate[]>;
}

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

export interface InsurancePlanResult {
  state: InsuranceSleeveState;
  plannedAction: 'OPEN' | 'CLOSE' | 'HOLD' | 'NONE' | 'ROLL';
  order?: any;
  rollOrder?: any;
  reason?: string;
  reserveContext?: {
    reservePoolUsd: number;
    sleeveBudgetUsd: number;
    consumedUsd: number;
    availableUsd: number;
    entryTargetUsd?: number;
    maxInsuranceBudgetUsd?: number;
    trancheCount?: number;
  };
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

const defaultState: InsuranceSleeveState = { status: 'INACTIVE' };

const statePathForEnv = (env?: string, accountKey?: string) => {
  const override = process.env.INSURANCE_STATE_PATH;
  if (override) return path.resolve(process.cwd(), override);
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
  reserveBudget?: number;
  reservePoolUsd?: number;
  cashAvailable?: number;
  quotes: Record<string, number>;
  optionPositions?: OptionPositionSnapshot[];
  optionMarks?: OptionMarkSnapshot[];
  regimes?: RegimeContext;
  dislocationState?: {
    active?: boolean;
    phase?: string;
    currentTier?: number;
    triggeredAtISO?: string;
    postRiskOffEpisodeStartISO?: string;
  };
  chainProvider?: OptionChainProvider;
  env?: string;
  accountKey?: string;
}

const INITIAL_TRANCHE_PCT = 0.12;
const ADD_TRANCHE_PCT = 0.08;
const MAX_TOTAL_INSURANCE_PCT = 0.28;
const CONFIRMATION_STEPS = 2;
const NORMALIZATION_STEPS = 2;
const MAX_TRANCHES = 3;
const PANIC_TIER = 3;

export const planInsuranceSleeve = async (input: InsurancePlannerInput): Promise<InsurancePlanResult> => {
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
    regimes,
    dislocationState,
    chainProvider,
    env,
    accountKey
  } = input;
  const flags: InsurancePlanResult['flags'] = [];
  const state = loadInsuranceState(env, accountKey);
  const reservePool = reservePoolUsd ?? reserveBudget ?? 0;
  const maxInsuranceBudgetPct = Math.min(config.insurance?.spendPct ?? MAX_TOTAL_INSURANCE_PCT, MAX_TOTAL_INSURANCE_PCT);
  const sleeveBudget = reservePool * maxInsuranceBudgetPct;
  const relevantPositions = (optionPositions || []).filter((p) => p.type === 'PUT');
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
  const nearExpiryDays = config.insurance?.closeWithinDays ?? 21;
  const allowExpire = config.insurance?.allowExpire ?? false;

  const findMark = (p: OptionPositionSnapshot): OptionMarkSnapshot | undefined => {
    const id = `${p.underlying || 'UNK'}:${p.type || 'UNK'}:${p.strike || 'UNK'}:${p.expiry || 'UNK'}`;
    return (optionMarks || []).find((m) => m.positionId === id);
  };

  const deriveStateFromPositions = (): InsuranceSleeveState => {
    if (!relevantPositions.length) return state;
    const p = relevantPositions[0];
    return {
      ...state,
      status: 'DEPLOYED',
      openedRunId: state.openedRunId,
      openedAsOf: state.openedAsOf,
      underlying: p.underlying || undefined,
      strike: p.strike || undefined,
      expiry: p.expiry || undefined,
      contracts: relevantPositions.reduce((sum, position) => sum + (position.contracts || 0), 0) || undefined,
      premiumUSD: consumedReserve || undefined,
      stagedEntryCount: Math.max(state.stagedEntryCount || 0, relevantPositions.length)
    };
  };

  const workingState = state.status === 'INACTIVE' && relevantPositions.length ? deriveStateFromPositions() : state;
  const normalTierThreshold = Math.max(2, config.dislocation?.minActiveTier ?? 2);
  const dislocationActive = dislocationState?.active === true;
  const dislocationPhase = dislocationState?.phase || 'INACTIVE';
  const dislocationTier = dislocationState?.currentTier ?? 0;
  const severeVol = regimes?.volRegime?.label === 'stressed';
  const stressEligiblePhase = dislocationPhase === 'ADD' || dislocationPhase === 'HOLD';
  const confirmedDislocationStress = dislocationActive && stressEligiblePhase && dislocationTier >= normalTierThreshold;
  const panicOverride = dislocationActive && stressEligiblePhase && dislocationTier >= PANIC_TIER;
  const normalizationCandidate = !dislocationActive && !severeVol;
  const currentEpisodeId =
    dislocationState?.triggeredAtISO || dislocationState?.postRiskOffEpisodeStartISO || workingState.activeEpisodeId;

  if (currentEpisodeId && currentEpisodeId !== workingState.activeEpisodeId) {
    workingState.activeEpisodeId = currentEpisodeId;
    workingState.stagedEntryCount = relevantPositions.length ? relevantPositions.length : 0;
    workingState.consecutiveStressSteps = 0;
    workingState.consecutiveNormalizationSteps = 0;
  }

  workingState.consecutiveStressSteps = confirmedDislocationStress || panicOverride ? (workingState.consecutiveStressSteps || 0) + 1 : 0;
  workingState.consecutiveNormalizationSteps = normalizationCandidate ? (workingState.consecutiveNormalizationSteps || 0) + 1 : 0;

  const result: InsurancePlanResult = {
    state: workingState,
    plannedAction: 'NONE',
    flags,
    reserveContext: {
      reservePoolUsd: reservePool,
      sleeveBudgetUsd: sleeveBudget,
      consumedUsd: consumedReserve,
      availableUsd: availableReserve,
      maxInsuranceBudgetUsd: sleeveBudget,
      trancheCount: workingState.stagedEntryCount || 0
    }
  };

  const buildOpenOrder = async (targetSpendUsd: number) => {
    const underlyingSel = selectOptionsUnderlying('HEDGE', config);
    if (!underlyingSel.symbol) {
      result.reason = 'No underlying available';
      return null;
    }
    const px = quotes[underlyingSel.symbol];
    if (!px || px <= 0) {
      result.reason = 'Underlying price unavailable';
      return null;
    }

    const contract = await selectInsuranceContract(underlyingSel.symbol, asOf, px, config, chainProvider);
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
      order: buildBuyToOpenPut(contract, contracts, config)
    };
  };

  const canOpenNormal = confirmedDislocationStress && (workingState.consecutiveStressSteps || 0) >= CONFIRMATION_STEPS;
  const canOpenNow = panicOverride || canOpenNormal;
  const totalMarketValueUsd = relevantPositions.reduce((sum, position) => sum + marketValueForPosition(position), 0);
  const severeStressStillActive = confirmedDislocationStress || severeVol || panicOverride;

  // If already deployed
  if (workingState.status === 'DEPLOYED' || relevantPositions.length) {
    workingState.status = relevantPositions.length ? 'DEPLOYED' : workingState.status;
    const earliestExpiryMark = relevantPositions
      .map((position) => ({ position, mark: findMark(position) }))
      .sort((a, b) => (a.mark?.daysToExpiry ?? Number.POSITIVE_INFINITY) - (b.mark?.daysToExpiry ?? Number.POSITIVE_INFINITY))[0];
    const daysToExpiry = earliestExpiryMark?.mark?.daysToExpiry ?? null;
    const nearExpiry = daysToExpiry !== null && daysToExpiry !== undefined ? daysToExpiry <= nearExpiryDays : false;

    if ((workingState.consecutiveNormalizationSteps || 0) >= NORMALIZATION_STEPS && !sameDay) {
      result.plannedAction = 'CLOSE';
      result.order = stateToCloseOrder(workingState, config);
      flags.push({
        code: 'INSURANCE_CLOSE_CONFIRMED_NORMALIZATION',
        severity: 'info',
        message: 'Insurance closed after confirmed normalization.',
        observed: { normalizationSteps: workingState.consecutiveNormalizationSteps }
      });
      workingState.status = 'UNWINDING';
      workingState.activeEpisodeId = undefined;
      workingState.stagedEntryCount = 0;
      saveInsuranceState(workingState, env, accountKey);
      return result;
    }

    if (nearExpiry && severeStressStillActive && !sameDay) {
      if (allowExpire) {
        flags.push({ code: 'INSURANCE_NEAR_EXPIRY', severity: 'info', message: 'Option near expiry; allow to expire.' });
        result.plannedAction = 'HOLD';
      } else {
        const rollTargetSpendUsd = Math.min(
          sleeveBudget,
          Math.max(totalMarketValueUsd, reservePool * INITIAL_TRANCHE_PCT)
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
          workingState.lastEntryAsOf = asOf;
          flags.push({
            code: 'INSURANCE_ROLL_PLANNED',
            severity: 'info',
            message: 'Insurance protection rolled forward during sustained stress.',
            observed: { targetSpendUsd: rollTargetSpendUsd, contracts: roll.contracts }
          });
          result.reserveContext = {
            ...result.reserveContext!,
            entryTargetUsd: rollTargetSpendUsd
          };
        } else {
          result.plannedAction = 'HOLD';
        }
      }
      saveInsuranceState(workingState, env, accountKey);
      return result;
    }

    const stagedEntryCount = workingState.stagedEntryCount || relevantPositions.length || 1;
    const maxAdditionalSpendUsd = Math.max(0, sleeveBudget - consumedReserve);
    const canAddTranche =
      panicOverride &&
      !sameDay &&
      stagedEntryCount < MAX_TRANCHES &&
      maxAdditionalSpendUsd > 0 &&
      workingState.lastEntryAsOf?.slice(0, 10) !== asOf.slice(0, 10);

    if (canAddTranche) {
      const addTargetSpendUsd = Math.min(reservePool * ADD_TRANCHE_PCT, maxAdditionalSpendUsd);
      const add = await buildOpenOrder(addTargetSpendUsd);
      if (add) {
        result.plannedAction = 'OPEN';
        result.order = add.order;
        workingState.openedRunId = runId;
        workingState.openedAsOf = workingState.openedAsOf || asOf;
        workingState.underlying = add.contract.symbol;
        workingState.expiry = add.contract.expiry;
        workingState.strike = add.contract.strike;
        workingState.contracts = (workingState.contracts || 0) + add.contracts;
        workingState.premiumUSD = consumedReserve + add.notional;
        workingState.stagedEntryCount = stagedEntryCount + 1;
        workingState.lastEntryAsOf = asOf;
        flags.push({
          code: 'INSURANCE_ADD_TRANCHE_PLANNED',
          severity: 'info',
          message: 'Additional insurance tranche planned during capitulation stress.',
          observed: { targetSpendUsd: addTargetSpendUsd, contracts: add.contracts, tranche: workingState.stagedEntryCount }
        });
        result.reserveContext = {
          ...result.reserveContext!,
          entryTargetUsd: addTargetSpendUsd,
          trancheCount: workingState.stagedEntryCount
        };
        saveInsuranceState(workingState, env, accountKey);
        return result;
      }
    }

    result.plannedAction = 'HOLD';
    saveInsuranceState(workingState, env, accountKey);
    return result;
  }

  if (!arbitratorAllowed || !canOpenNow) {
    if (!arbitratorAllowed) {
      result.reason = 'Insurance not allowed';
    } else if (!confirmedDislocationStress && !panicOverride) {
      result.reason = 'Insurance requires active dislocation in ADD/HOLD at tier >= 2';
    } else {
      result.reason = `Awaiting ${CONFIRMATION_STEPS}-step stress confirmation`;
    }
    saveInsuranceState(workingState, env, accountKey);
    return result;
  }

  const entryTargetSpendUsd = Math.min(reservePool * INITIAL_TRANCHE_PCT, sleeveBudget);
  const open = await buildOpenOrder(entryTargetSpendUsd);
  if (!open) {
    saveInsuranceState(workingState, env, accountKey);
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
  workingState.stagedEntryCount = Math.max(1, workingState.stagedEntryCount || 0 || 1);
  workingState.lastEntryAsOf = asOf;

  result.plannedAction = 'OPEN';
  result.order = open.order;
  result.reserveContext = {
    ...result.reserveContext!,
    entryTargetUsd: entryTargetSpendUsd,
    trancheCount: workingState.stagedEntryCount
  };
  result.flags.push({
    code: panicOverride ? 'INSURANCE_OPEN_PANIC_OVERRIDE' : 'INSURANCE_OPEN_CONFIRMED_DISLOCATION',
    severity: 'info',
    message: panicOverride ? 'Insurance sleeve opening on capitulation override.' : 'Insurance sleeve opening on confirmed dislocation stress.',
    observed: {
      notional: open.notional,
      contracts: open.contracts,
      underlying: open.contract.symbol,
      strike: open.contract.strike,
      expiry: open.contract.expiry,
      tier: dislocationTier,
      stressSteps: workingState.consecutiveStressSteps
    }
  });
  saveInsuranceState(workingState, env, accountKey);
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
