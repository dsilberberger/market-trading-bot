import { BotConfig, TradeOrder } from './types';

interface NavResult {
  nav: number;
  invested: number;
  cash: number;
}

export interface CapitalLaneSnapshot {
  navUsd: number;
  totalCashUsd: number;
  etfInvestedUsd: number;
  coreCapitalUsd: number;
  coreHeadroomUsd: number;
  coreCashUsd: number;
  optionsReserveCapitalUsd: number;
  optionsReserveHeadroomUsd: number;
  optionsReserveCashUsd: number;
  executedOptionReserveUsageUsd: number;
  unassignedCashUsd: number;
}

export interface ReRiskSequenceCatchUpInput {
  config: BotConfig;
  regimeLabel?: string | null;
  timeInRegimeWeeks?: number;
  currentEquityAllocationPct: number;
  optionsReserveCashUsd: number;
}

export interface ReRiskSequenceCatchUpResult {
  active: boolean;
  supplementUsd: number;
  supplementPct: number;
  favorableSequenceWeeks: number;
  reason:
    | 'disabled'
    | 'not_risk_on'
    | 'insufficient_sequence'
    | 'not_underinvested'
    | 'no_reserve_cash'
    | 'active';
}

export interface CoreCapacityHeadroomExpansionInput {
  config: BotConfig;
  regimeLabel?: string | null;
  timeInRegimeWeeks?: number;
  currentEquityAllocationPct: number;
  optionsReserveCashUsd: number;
}

export interface CoreCapacityHeadroomExpansionResult {
  active: boolean;
  supplementUsd: number;
  supplementPct: number;
  favorableSequenceWeeks: number;
  reason:
    | 'disabled'
    | 'not_risk_on'
    | 'insufficient_sequence'
    | 'not_underinvested'
    | 'no_reserve_cash'
    | 'active';
}

export interface FavorableStatePersistenceInput {
  config: BotConfig;
  regimeLabel?: string | null;
  timeInRegimeWeeks?: number;
  currentEquityAllocationPct: number;
}

export interface FavorableStatePersistenceResult {
  active: boolean;
  favorableSequenceWeeks: number;
  maxPersistentOverweightPct: number;
  reason:
    | 'disabled'
    | 'not_risk_on'
    | 'insufficient_sequence'
    | 'not_underinvested'
    | 'active';
}

export interface ReRiskCorridorState {
  active: boolean;
  entryDate: string | null;
  entryEquityAllocationPct: number;
  currentCorridorTargetPct: number;
  favorableSequenceWeeks: number;
  stallCount: number;
  lastObservedEquityAllocationPct: number;
  lastAdvanceDate: string | null;
  lastAction: 'inactive' | 'entry' | 'advance' | 'pause' | 'exit';
  lastExitReason: string | null;
}

export interface ReRiskCorridorInput {
  config: BotConfig;
  priorState?: ReRiskCorridorState;
  asOf: string;
  regimeLabel?: string | null;
  currentEquityAllocationPct: number;
  currentEquityMarketValueUsd: number;
  navUsd: number;
  favorableStateCeilingPct: number;
}

export interface ReRiskCorridorResult {
  active: boolean;
  state: ReRiskCorridorState;
  currentCorridorTargetPct: number;
  effectiveCeilingPct: number;
  intendedIncrementalReRiskUsd: number;
  supplementalCapacityUsd: number;
  favorableSequenceWeeks: number;
  entryReason:
    | null
    | 'risk_on_underinvested_entry';
  advanceReason:
    | null
    | 'caught_up_to_corridor_target'
    | 'realized_progress_within_stall_tolerance';
  pauseReason:
    | null
    | 'insufficient_realized_progress';
  exitReason:
    | null
    | 'disabled'
    | 'regime_not_risk_on'
    | 'exposure_recovered';
}

export interface ExposureStateControllerState {
  active: boolean;
  phase: 'inactive' | 'building' | 'holding' | 'paused' | 'exited';
  entryDate: string | null;
  entryEquityAllocationPct: number;
  targetCoreEquityPct: number;
  priorTargetCoreEquityPct: number;
  favorableSequenceWeeks: number;
  consecutiveStallWeeks: number;
  lastRealizedEquityAllocationPct: number;
  lastRequestedExposureDeltaUsd: number;
  lastRealizedExposureDeltaPct: number;
  lastAction: 'entry' | 'advance' | 'hold' | 'pause' | 'exit' | 'inactive';
  lastReason: string | null;
}

export interface ExposureStateControllerInput {
  config: BotConfig;
  priorState?: ExposureStateControllerState;
  asOf: string;
  regimeLabel?: string | null;
  currentEquityAllocationPct: number;
  currentEquityMarketValueUsd: number;
  navUsd: number;
  favorableStateCeilingPct: number;
  systemAllowedEquityCeilingPct: number;
  minimumExecutableDeltaUsd?: number;
  handoffContractType?: ExposureStateHandoffContractType;
}

export interface ExposureStateControllerResult {
  active: boolean;
  state: ExposureStateControllerState;
  targetCoreEquityPct: number;
  targetCoreEquityUsd: number;
  effectiveCeilingPct: number;
  requestedExposureDeltaPct: number;
  requestedExposureDeltaUsd: number;
  controllerAction: ExposureStateControllerState['lastAction'];
  controllerReason: string | null;
  minimumExecutableDeltaUsd: number;
}

export type ExposureStateHandoffContractType =
  | 'scaled_target_basket'
  | 'incremental_exposure_delta_v1'
  | 'incremental_exposure_delta_v2';

export interface IncrementalExposureDeltaContract {
  contractType: 'incremental_exposure_delta_v1' | 'incremental_exposure_delta_v2';
  active: boolean;
  asOf: string;
  controllerAction: ExposureStateControllerState['lastAction'];
  controllerReason: string | null;
  targetCoreEquityPct: number;
  targetCoreEquityUsd: number;
  requestedExposureDeltaPct: number;
  requestedExposureDeltaUsd: number;
  deltaBuyBudgetUsd: number;
  minimumExecutableDeltaUsd: number;
  effectiveCeilingPct: number;
  systemAllowedEquityCeilingPct: number;
  basis: {
    regimeLabel?: string | null;
    currentEquityAllocationPct: number;
    currentEquityMarketValueUsd: number;
    navUsd: number;
  };
}

export const getExposureStateHandoffContractType = (
  config: BotConfig
): ExposureStateHandoffContractType =>
  config.reRiskCorridor?.handoffContract === 'incremental_exposure_delta_v2'
    ? 'incremental_exposure_delta_v2'
    : config.reRiskCorridor?.handoffContract === 'incremental_exposure_delta_v1'
    ? 'incremental_exposure_delta_v1'
    : 'scaled_target_basket';

export const buildIncrementalExposureDeltaContract = ({
  contractType,
  asOf,
  regimeLabel,
  currentEquityAllocationPct,
  currentEquityMarketValueUsd,
  navUsd,
  systemAllowedEquityCeilingPct,
  exposureState,
  deltaBuyBudgetUsd,
  minimumExecutableDeltaUsd
}: {
  contractType: 'incremental_exposure_delta_v1' | 'incremental_exposure_delta_v2';
  asOf: string;
  regimeLabel?: string | null;
  currentEquityAllocationPct: number;
  currentEquityMarketValueUsd: number;
  navUsd: number;
  systemAllowedEquityCeilingPct: number;
  exposureState: ExposureStateControllerResult;
  deltaBuyBudgetUsd: number;
  minimumExecutableDeltaUsd: number;
}): IncrementalExposureDeltaContract => ({
  contractType,
  active: exposureState.active,
  asOf,
  controllerAction: exposureState.controllerAction,
  controllerReason: exposureState.controllerReason,
  targetCoreEquityPct: exposureState.targetCoreEquityPct,
  targetCoreEquityUsd: exposureState.targetCoreEquityUsd,
  requestedExposureDeltaPct: exposureState.requestedExposureDeltaPct,
  requestedExposureDeltaUsd: exposureState.requestedExposureDeltaUsd,
  deltaBuyBudgetUsd,
  minimumExecutableDeltaUsd,
  effectiveCeilingPct: exposureState.effectiveCeilingPct,
  systemAllowedEquityCeilingPct,
  basis: {
    regimeLabel,
    currentEquityAllocationPct,
    currentEquityMarketValueUsd,
    navUsd
  }
});

export const computeOptionReserveUsageUsd = (
  positions: Array<{
    costBasisUsd?: number;
    avgOpenPrice?: number;
    contracts?: number;
    multiplier?: number;
  }> = []
) =>
  positions.reduce((sum, position) => {
    const fallback =
      (position.avgOpenPrice || 0) * (position.contracts || 0) * (position.multiplier || 100);
    return sum + Math.max(0, position.costBasisUsd ?? fallback);
  }, 0);

export const computeNav = (
  holdings: Array<{ symbol: string; quantity: number }>,
  cash: number,
  quotes: Record<string, number>,
  optionMarketValueUsd = 0
): NavResult => {
  const invested = (holdings || []).reduce((acc, h) => {
    const px = quotes?.[h.symbol] ?? 0;
    return acc + (h.quantity || 0) * px;
  }, 0);
  const nav = invested + (cash || 0) + Math.max(0, optionMarketValueUsd || 0);
  return { nav, invested, cash: cash || 0 };
};

export const computeBudgets = (nav: number, config: BotConfig) => {
  const corePct = config.capital?.corePct ?? 0.85;
  const reservePct = config.capital?.reservePct ?? 0.15;
  const coreBudget = nav * corePct;
  const reserveBudget = nav * reservePct;
  return { coreBudget, reserveBudget };
};

export const computeCapitalLanes = ({
  navUsd,
  etfInvestedUsd,
  cashUsd,
  executedOptionReserveUsageUsd,
  config
}: {
  navUsd: number;
  etfInvestedUsd: number;
  cashUsd: number;
  executedOptionReserveUsageUsd: number;
  config: BotConfig;
}): CapitalLaneSnapshot => {
  const { coreBudget, reserveBudget } = computeBudgets(navUsd, config);
  const coreHeadroomUsd = Math.max(0, coreBudget - etfInvestedUsd);
  const optionsReserveHeadroomUsd = Math.max(0, reserveBudget - executedOptionReserveUsageUsd);
  const optionsReserveCashUsd = Math.min(Math.max(0, cashUsd), optionsReserveHeadroomUsd);
  const residualCashUsd = Math.max(0, cashUsd - optionsReserveCashUsd);
  const coreCashUsd = Math.min(residualCashUsd, coreHeadroomUsd);
  const unassignedCashUsd = Math.max(0, cashUsd - optionsReserveCashUsd - coreCashUsd);

  return {
    navUsd,
    totalCashUsd: cashUsd,
    etfInvestedUsd,
    coreCapitalUsd: coreBudget,
    coreHeadroomUsd,
    coreCashUsd,
    optionsReserveCapitalUsd: reserveBudget,
    optionsReserveHeadroomUsd,
    optionsReserveCashUsd,
    executedOptionReserveUsageUsd,
    unassignedCashUsd
  };
};

export const clampBuyOrdersToBudget = (orders: TradeOrder[], maxBuyNotional: number) => {
  const buys = orders.filter((o) => o.side === 'BUY');
  const buyTotal = buys.reduce((acc, o) => acc + o.notionalUSD, 0);
  if (buyTotal <= maxBuyNotional || buyTotal === 0) return orders;
  const scale = maxBuyNotional / buyTotal;
  return orders.map((o) => {
    if (o.side !== 'BUY') return o;
    return { ...o, notionalUSD: o.notionalUSD * scale };
  });
};

export const computeCoreBuyCapacityUsd = ({
  coreCashUsd,
  coreHeadroomUsd,
  estimatedSellProceedsUsd,
  supplementalCapacityUsd = 0
}: {
  coreCashUsd: number;
  coreHeadroomUsd: number;
  estimatedSellProceedsUsd: number;
  supplementalCapacityUsd?: number;
}) =>
  Math.max(
    0,
    Math.min(
      coreCashUsd + estimatedSellProceedsUsd + supplementalCapacityUsd,
      coreHeadroomUsd + estimatedSellProceedsUsd + supplementalCapacityUsd
    )
  );

export const computeCoreDeployPct = (
  regimes: any,
  config: BotConfig
): { deployPct: number; confidenceScale: number } => {
  const label = regimes?.equityRegime?.label;
  const confidence = regimes?.equityRegime?.confidence ?? 1;
  const baseDeployMap =
    config.capital?.baseDeployPct || { risk_off: 0.35, neutral: 0.6, risk_on: 0.8, fallback: 0.5 };
  let basePct = baseDeployMap.fallback ?? 0.5;
  if (label === 'risk_off') basePct = baseDeployMap.risk_off ?? basePct;
  else if (label === 'neutral') basePct = baseDeployMap.neutral ?? basePct;
  else if (label === 'risk_on') basePct = baseDeployMap.risk_on ?? basePct;
  const confThreshold = config.capital?.deployConfThreshold ?? 0.5;
  const scaleLow = config.capital?.deployConfScaleLow ?? 0.9;
  const confidenceScale = confidence < confThreshold ? scaleLow : 1;
  const deployPct = Math.min(1, Math.max(0, basePct * confidenceScale));
  return { deployPct, confidenceScale };
};

export const computeReRiskSequenceCatchUp = ({
  config,
  regimeLabel,
  timeInRegimeWeeks,
  currentEquityAllocationPct,
  optionsReserveCashUsd
}: ReRiskSequenceCatchUpInput): ReRiskSequenceCatchUpResult => {
  const policy = config.reRiskAcceleration;
  if (!policy || policy.mode !== 'risk_on_sequence_catchup') {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks: Math.max(0, timeInRegimeWeeks ?? 0),
      reason: 'disabled'
    };
  }

  if (regimeLabel !== 'risk_on') {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks: Math.max(0, timeInRegimeWeeks ?? 0),
      reason: 'not_risk_on'
    };
  }

  const favorableSequenceWeeks = Math.max(0, timeInRegimeWeeks ?? 0);
  const minRiskOnWeeks = Math.max(1, policy.minRiskOnWeeks ?? 2);
  if (favorableSequenceWeeks < minRiskOnWeeks) {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks,
      reason: 'insufficient_sequence'
    };
  }

  const lowEquityThreshold = Math.max(0, Math.min(1, policy.lowEquityAllocationThresholdPct ?? 0.4));
  if (currentEquityAllocationPct >= lowEquityThreshold) {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks,
      reason: 'not_underinvested'
    };
  }

  if (optionsReserveCashUsd <= 0) {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks,
      reason: 'no_reserve_cash'
    };
  }

  const reserveSupplementPctPerWeek = Math.max(0, policy.reserveSupplementPctPerWeek ?? 0.2);
  const maxReserveSupplementPct = Math.max(
    reserveSupplementPctPerWeek,
    policy.maxReserveSupplementPct ?? 0.6
  );
  const activeWeeks = favorableSequenceWeeks - minRiskOnWeeks + 1;
  const supplementPct = Math.min(maxReserveSupplementPct, reserveSupplementPctPerWeek * activeWeeks);
  const supplementUsd = Math.max(0, optionsReserveCashUsd * supplementPct);

  return {
    active: supplementUsd > 0,
    supplementUsd,
    supplementPct,
    favorableSequenceWeeks,
    reason: supplementUsd > 0 ? 'active' : 'no_reserve_cash'
  };
};

export const computeCoreCapacityHeadroomExpansion = ({
  config,
  regimeLabel,
  timeInRegimeWeeks,
  currentEquityAllocationPct,
  optionsReserveCashUsd
}: CoreCapacityHeadroomExpansionInput): CoreCapacityHeadroomExpansionResult => {
  const policy = config.coreCapacityFormation;
  if (!policy || policy.mode !== 'risk_on_headroom_expansion') {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks: Math.max(0, timeInRegimeWeeks ?? 0),
      reason: 'disabled'
    };
  }

  if (regimeLabel !== 'risk_on') {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks: Math.max(0, timeInRegimeWeeks ?? 0),
      reason: 'not_risk_on'
    };
  }

  const favorableSequenceWeeks = Math.max(0, timeInRegimeWeeks ?? 0);
  const minRiskOnWeeks = Math.max(1, policy.minRiskOnWeeks ?? 2);
  if (favorableSequenceWeeks < minRiskOnWeeks) {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks,
      reason: 'insufficient_sequence'
    };
  }

  const lowEquityThreshold = Math.max(0, Math.min(1, policy.lowEquityAllocationThresholdPct ?? 0.4));
  if (currentEquityAllocationPct >= lowEquityThreshold) {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks,
      reason: 'not_underinvested'
    };
  }

  if (optionsReserveCashUsd <= 0) {
    return {
      active: false,
      supplementUsd: 0,
      supplementPct: 0,
      favorableSequenceWeeks,
      reason: 'no_reserve_cash'
    };
  }

  const reserveHeadroomPctPerWeek = Math.max(0, policy.reserveHeadroomPctPerWeek ?? 0.2);
  const maxReserveHeadroomPct = Math.max(
    reserveHeadroomPctPerWeek,
    policy.maxReserveHeadroomPct ?? 0.6
  );
  const activeWeeks = favorableSequenceWeeks - minRiskOnWeeks + 1;
  const supplementPct = Math.min(maxReserveHeadroomPct, reserveHeadroomPctPerWeek * activeWeeks);
  const supplementUsd = Math.max(0, optionsReserveCashUsd * supplementPct);

  return {
    active: supplementUsd > 0,
    supplementUsd,
    supplementPct,
    favorableSequenceWeeks,
    reason: supplementUsd > 0 ? 'active' : 'no_reserve_cash'
  };
};

const buildInactiveCorridorState = (
  lastObservedEquityAllocationPct: number,
  lastAction: ReRiskCorridorState['lastAction'] = 'inactive',
  lastExitReason: string | null = null
): ReRiskCorridorState => ({
  active: false,
  entryDate: null,
  entryEquityAllocationPct: 0,
  currentCorridorTargetPct: 0,
  favorableSequenceWeeks: 0,
  stallCount: 0,
  lastObservedEquityAllocationPct,
  lastAdvanceDate: null,
  lastAction,
  lastExitReason
});

const buildInactiveExposureState = (
  currentEquityAllocationPct: number,
  action: ExposureStateControllerState['lastAction'] = 'inactive',
  reason: string | null = null
): ExposureStateControllerState => ({
  active: false,
  phase: action === 'exit' ? 'exited' : 'inactive',
  entryDate: null,
  entryEquityAllocationPct: 0,
  targetCoreEquityPct: 0,
  priorTargetCoreEquityPct: 0,
  favorableSequenceWeeks: 0,
  consecutiveStallWeeks: 0,
  lastRealizedEquityAllocationPct: currentEquityAllocationPct,
  lastRequestedExposureDeltaUsd: 0,
  lastRealizedExposureDeltaPct: 0,
  lastAction: action,
  lastReason: reason
});

export const computeReRiskCorridor = ({
  config,
  priorState,
  asOf,
  regimeLabel,
  currentEquityAllocationPct,
  currentEquityMarketValueUsd,
  navUsd,
  favorableStateCeilingPct
}: ReRiskCorridorInput): ReRiskCorridorResult => {
  const policy = config.reRiskCorridor;
  const inactive = buildInactiveCorridorState(currentEquityAllocationPct, 'inactive', 'disabled');
  if (!policy || policy.mode !== 'stateful_risk_on_corridor') {
    return {
      active: false,
      state: inactive,
      currentCorridorTargetPct: 0,
      effectiveCeilingPct: 0,
      intendedIncrementalReRiskUsd: 0,
      supplementalCapacityUsd: 0,
      favorableSequenceWeeks: 0,
      entryReason: null,
      advanceReason: null,
      pauseReason: null,
      exitReason: 'disabled'
    };
  }

  const entryThreshold = Math.max(0, Math.min(1, policy.entryEquityAllocationThresholdPct ?? 0.4));
  const weeklyAdvancePct = Math.max(0, policy.weeklyAdvancePct ?? 0.05);
  const configuredCeilingPct = Math.max(entryThreshold, Math.min(1, policy.maxCorridorTargetPct ?? 0.6));
  const effectiveCeilingPct = Math.max(0, Math.min(configuredCeilingPct, favorableStateCeilingPct));
  const advanceTolerancePct = Math.max(0, policy.advanceTolerancePct ?? 0.01);
  const maxStallWeeks = Math.max(0, policy.maxStallWeeks ?? 1);
  const baselineState = priorState ?? buildInactiveCorridorState(currentEquityAllocationPct);

  if (regimeLabel !== 'risk_on') {
    return {
      active: false,
      state: buildInactiveCorridorState(currentEquityAllocationPct, 'exit', 'regime_not_risk_on'),
      currentCorridorTargetPct: 0,
      effectiveCeilingPct,
      intendedIncrementalReRiskUsd: 0,
      supplementalCapacityUsd: 0,
      favorableSequenceWeeks: 0,
      entryReason: null,
      advanceReason: null,
      pauseReason: null,
      exitReason: 'regime_not_risk_on'
    };
  }

  if (currentEquityAllocationPct >= effectiveCeilingPct - advanceTolerancePct) {
    return {
      active: false,
      state: buildInactiveCorridorState(currentEquityAllocationPct, 'exit', 'exposure_recovered'),
      currentCorridorTargetPct: 0,
      effectiveCeilingPct,
      intendedIncrementalReRiskUsd: 0,
      supplementalCapacityUsd: 0,
      favorableSequenceWeeks: 0,
      entryReason: null,
      advanceReason: null,
      pauseReason: null,
      exitReason: 'exposure_recovered'
    };
  }

  if (!baselineState.active) {
    if (currentEquityAllocationPct >= entryThreshold) {
      return {
        active: false,
        state: buildInactiveCorridorState(currentEquityAllocationPct),
        currentCorridorTargetPct: 0,
        effectiveCeilingPct,
        intendedIncrementalReRiskUsd: 0,
        supplementalCapacityUsd: 0,
        favorableSequenceWeeks: 0,
        entryReason: null,
        advanceReason: null,
        pauseReason: null,
        exitReason: null
      };
    }

    const state: ReRiskCorridorState = {
      active: true,
      entryDate: asOf,
      entryEquityAllocationPct: currentEquityAllocationPct,
      currentCorridorTargetPct: currentEquityAllocationPct,
      favorableSequenceWeeks: 1,
      stallCount: 0,
      lastObservedEquityAllocationPct: currentEquityAllocationPct,
      lastAdvanceDate: null,
      lastAction: 'entry',
      lastExitReason: null
    };
    return {
      active: true,
      state,
      currentCorridorTargetPct: state.currentCorridorTargetPct,
      effectiveCeilingPct,
      intendedIncrementalReRiskUsd: 0,
      supplementalCapacityUsd: 0,
      favorableSequenceWeeks: state.favorableSequenceWeeks,
      entryReason: 'risk_on_underinvested_entry',
      advanceReason: null,
      pauseReason: null,
      exitReason: null
    };
  }

  const caughtUpToTarget = currentEquityAllocationPct >= baselineState.currentCorridorTargetPct - advanceTolerancePct;
  const realizedProgressPct = currentEquityAllocationPct - baselineState.lastObservedEquityAllocationPct;
  const canAdvanceOnProgress =
    realizedProgressPct >= advanceTolerancePct && baselineState.stallCount <= maxStallWeeks;
  const canAdvance = caughtUpToTarget || canAdvanceOnProgress;
  const favorableSequenceWeeks = baselineState.favorableSequenceWeeks + 1;

  let currentCorridorTargetPct = baselineState.currentCorridorTargetPct;
  let stallCount = baselineState.stallCount;
  let lastAdvanceDate = baselineState.lastAdvanceDate;
  let lastAction: ReRiskCorridorState['lastAction'] = 'pause';
  let advanceReason: ReRiskCorridorResult['advanceReason'] = null;
  let pauseReason: ReRiskCorridorResult['pauseReason'] = null;

  if (canAdvance) {
    currentCorridorTargetPct = Math.min(
      effectiveCeilingPct,
      Math.max(baselineState.currentCorridorTargetPct, currentEquityAllocationPct) + weeklyAdvancePct
    );
    stallCount = 0;
    lastAdvanceDate = asOf;
    lastAction = 'advance';
    advanceReason = caughtUpToTarget
      ? 'caught_up_to_corridor_target'
      : 'realized_progress_within_stall_tolerance';
  } else {
    stallCount += 1;
    lastAction = 'pause';
    pauseReason = 'insufficient_realized_progress';
  }

  const targetEquityUsd = currentCorridorTargetPct * navUsd;
  const intendedIncrementalReRiskUsd = Math.max(0, targetEquityUsd - currentEquityMarketValueUsd);

  const state: ReRiskCorridorState = {
    active: true,
    entryDate: baselineState.entryDate,
    entryEquityAllocationPct: baselineState.entryEquityAllocationPct,
    currentCorridorTargetPct,
    favorableSequenceWeeks,
    stallCount,
    lastObservedEquityAllocationPct: currentEquityAllocationPct,
    lastAdvanceDate,
    lastAction,
    lastExitReason: null
  };

  return {
    active: true,
    state,
    currentCorridorTargetPct,
    effectiveCeilingPct,
    intendedIncrementalReRiskUsd,
    supplementalCapacityUsd: intendedIncrementalReRiskUsd,
    favorableSequenceWeeks,
    entryReason: null,
    advanceReason,
    pauseReason,
    exitReason: null
  };
};

export const computeExposureStateController = ({
  config,
  priorState,
  asOf,
  regimeLabel,
  currentEquityAllocationPct,
  currentEquityMarketValueUsd,
  navUsd,
  favorableStateCeilingPct,
  systemAllowedEquityCeilingPct,
  minimumExecutableDeltaUsd: minimumExecutableDeltaUsdInput = 0,
  handoffContractType: handoffContractTypeInput
}: ExposureStateControllerInput): ExposureStateControllerResult => {
  const policy = config.reRiskCorridor;
  const handoffContractType = handoffContractTypeInput ?? getExposureStateHandoffContractType(config);
  const executableDeltaAware = handoffContractType === 'incremental_exposure_delta_v2';
  const minimumExecutableDeltaUsd = executableDeltaAware ? Math.max(0, minimumExecutableDeltaUsdInput || 0) : 0;
  if (!policy || policy.mode !== 'stateful_risk_on_corridor_v2') {
    return {
      active: false,
      state: buildInactiveExposureState(currentEquityAllocationPct, 'inactive', 'disabled'),
      targetCoreEquityPct: 0,
      targetCoreEquityUsd: 0,
      effectiveCeilingPct: 0,
      requestedExposureDeltaPct: 0,
      requestedExposureDeltaUsd: 0,
      controllerAction: 'inactive',
      controllerReason: 'disabled',
      minimumExecutableDeltaUsd
    };
  }

  const entryThreshold = Math.max(0, Math.min(1, policy.entryEquityAllocationThresholdPct ?? 0.4));
  const weeklyAdvancePct = Math.max(0, policy.weeklyAdvancePct ?? 0.05);
  const progressThresholdPct = Math.max(0, policy.progressThresholdPct ?? policy.advanceTolerancePct ?? 0.01);
  const maxStallWeeks = Math.max(0, policy.maxStallWeeks ?? 1);
  const configuredCeilingPct = Math.max(entryThreshold, Math.min(1, policy.maxCorridorTargetPct ?? 0.6));
  const effectiveCeilingPct = Math.max(
    0,
    Math.min(configuredCeilingPct, favorableStateCeilingPct, systemAllowedEquityCeilingPct)
  );
  const baselineState = priorState ?? buildInactiveExposureState(currentEquityAllocationPct);
  const minimumExecutableDeltaPct = navUsd > 0 ? minimumExecutableDeltaUsd / navUsd : 0;
  const buildExecutableJumpTargetPct = () => {
    if (!executableDeltaAware || navUsd <= 0 || minimumExecutableDeltaUsd <= 0) return null;
    const remainingGapPct = Math.max(0, effectiveCeilingPct - currentEquityAllocationPct);
    if (remainingGapPct + 1e-9 < minimumExecutableDeltaPct) return null;
    return Math.min(effectiveCeilingPct, currentEquityAllocationPct + Math.max(weeklyAdvancePct, minimumExecutableDeltaPct));
  };
  const executableJumpTargetPct = buildExecutableJumpTargetPct();

  if (regimeLabel !== 'risk_on') {
    return {
      active: false,
      state: buildInactiveExposureState(currentEquityAllocationPct, 'exit', 'regime_not_risk_on'),
      targetCoreEquityPct: 0,
      targetCoreEquityUsd: 0,
      effectiveCeilingPct,
      requestedExposureDeltaPct: 0,
      requestedExposureDeltaUsd: 0,
      controllerAction: 'exit',
      controllerReason: 'regime_not_risk_on',
      minimumExecutableDeltaUsd
    };
  }

  if (currentEquityAllocationPct >= effectiveCeilingPct - progressThresholdPct) {
    return {
      active: false,
      state: buildInactiveExposureState(currentEquityAllocationPct, 'exit', 'exposure_recovered'),
      targetCoreEquityPct: 0,
      targetCoreEquityUsd: 0,
      effectiveCeilingPct,
      requestedExposureDeltaPct: 0,
      requestedExposureDeltaUsd: 0,
      controllerAction: 'exit',
      controllerReason: 'exposure_recovered',
      minimumExecutableDeltaUsd
    };
  }

  if (!baselineState.active) {
    if (currentEquityAllocationPct >= entryThreshold) {
      return {
        active: false,
        state: buildInactiveExposureState(currentEquityAllocationPct, 'inactive', 'entry_threshold_not_met'),
        targetCoreEquityPct: 0,
        targetCoreEquityUsd: 0,
        effectiveCeilingPct,
        requestedExposureDeltaPct: 0,
        requestedExposureDeltaUsd: 0,
        controllerAction: 'inactive',
        controllerReason: 'entry_threshold_not_met',
        minimumExecutableDeltaUsd
      };
    }

    const entryTargetCoreEquityPct =
      executableJumpTargetPct && executableJumpTargetPct > currentEquityAllocationPct + 1e-9
        ? executableJumpTargetPct
        : currentEquityAllocationPct;
    const entryTargetCoreEquityUsd = Math.max(0, entryTargetCoreEquityPct * navUsd);
    const entryRequestedExposureDeltaUsd = Math.max(0, entryTargetCoreEquityUsd - currentEquityMarketValueUsd);
    const entryRequestedExposureDeltaPct = Math.max(0, entryTargetCoreEquityPct - currentEquityAllocationPct);
    const entryReason =
      entryRequestedExposureDeltaUsd > 0 && executableDeltaAware
        ? 'risk_on_underinvested_entry_minimum_executable_jump'
        : 'risk_on_underinvested_entry';

    const state: ExposureStateControllerState = {
      active: true,
      phase: 'building',
      entryDate: asOf,
      entryEquityAllocationPct: currentEquityAllocationPct,
      targetCoreEquityPct: entryTargetCoreEquityPct,
      priorTargetCoreEquityPct: currentEquityAllocationPct,
      favorableSequenceWeeks: 1,
      consecutiveStallWeeks: 0,
      lastRealizedEquityAllocationPct: currentEquityAllocationPct,
      lastRequestedExposureDeltaUsd: entryRequestedExposureDeltaUsd,
      lastRealizedExposureDeltaPct: 0,
      lastAction: 'entry',
      lastReason: entryReason
    };
    return {
      active: true,
      state,
      targetCoreEquityPct: state.targetCoreEquityPct,
      targetCoreEquityUsd: entryTargetCoreEquityUsd,
      effectiveCeilingPct,
      requestedExposureDeltaPct: entryRequestedExposureDeltaPct,
      requestedExposureDeltaUsd: entryRequestedExposureDeltaUsd,
      controllerAction: 'entry',
      controllerReason: entryReason,
      minimumExecutableDeltaUsd
    };
  }

  const realizedProgressPct = currentEquityAllocationPct - baselineState.lastRealizedEquityAllocationPct;
  const hasAdvancedBeyondEntry =
    baselineState.targetCoreEquityPct > baselineState.entryEquityAllocationPct + 1e-9;
  const caughtUpToTarget =
    hasAdvancedBeyondEntry &&
    currentEquityAllocationPct >= baselineState.targetCoreEquityPct - progressThresholdPct;
  const canAdvanceOnProgress =
    realizedProgressPct >= progressThresholdPct && baselineState.consecutiveStallWeeks <= maxStallWeeks;
  const canAdvance = caughtUpToTarget || canAdvanceOnProgress;

  let nextTargetCoreEquityPct = baselineState.targetCoreEquityPct;
  let nextPhase: ExposureStateControllerState['phase'] = 'paused';
  let nextAction: ExposureStateControllerState['lastAction'] = 'pause';
  let nextReason = 'insufficient_realized_progress';
  let nextStallWeeks = baselineState.consecutiveStallWeeks + 1;

  if (canAdvance) {
    const advancedTargetPct = Math.min(
      effectiveCeilingPct,
      Math.max(baselineState.targetCoreEquityPct, currentEquityAllocationPct) + weeklyAdvancePct
    );
    if (advancedTargetPct > baselineState.targetCoreEquityPct + 1e-9) {
      nextTargetCoreEquityPct = advancedTargetPct;
      nextPhase = 'building';
      nextAction = 'advance';
      nextReason = caughtUpToTarget ? 'caught_up_to_target' : 'progress_threshold_met';
    } else {
      nextPhase = 'holding';
      nextAction = 'hold';
      nextReason = 'ceiling_bounded_hold';
    }
    nextStallWeeks = 0;
  }

  const rawRequestedExposureDeltaUsd = Math.max(0, nextTargetCoreEquityPct * navUsd - currentEquityMarketValueUsd);
  const remainingGapToCeilingUsd = Math.max(0, effectiveCeilingPct * navUsd - currentEquityMarketValueUsd);
  if (executableDeltaAware) {
    if (
      executableJumpTargetPct &&
      executableJumpTargetPct > nextTargetCoreEquityPct + 1e-9 &&
      (rawRequestedExposureDeltaUsd <= 1e-9 || rawRequestedExposureDeltaUsd + 1e-9 < minimumExecutableDeltaUsd)
    ) {
      nextTargetCoreEquityPct = executableJumpTargetPct;
      nextPhase = 'building';
      nextAction = 'advance';
      nextReason = 'minimum_executable_delta_jump';
      nextStallWeeks = 0;
    } else if (
      rawRequestedExposureDeltaUsd > 1e-9 &&
      rawRequestedExposureDeltaUsd + 1e-9 < minimumExecutableDeltaUsd &&
      remainingGapToCeilingUsd + 1e-9 < minimumExecutableDeltaUsd
    ) {
      nextTargetCoreEquityPct = currentEquityAllocationPct;
      nextPhase = 'holding';
      nextAction = 'hold';
      nextReason = 'minimum_executable_delta_unreachable';
      nextStallWeeks = 0;
    }
  }

  const targetCoreEquityUsd = Math.max(0, nextTargetCoreEquityPct * navUsd);
  const requestedExposureDeltaUsd = Math.max(0, targetCoreEquityUsd - currentEquityMarketValueUsd);
  const requestedExposureDeltaPct = Math.max(0, nextTargetCoreEquityPct - currentEquityAllocationPct);

  const state: ExposureStateControllerState = {
    active: true,
    phase: nextPhase,
    entryDate: baselineState.entryDate,
    entryEquityAllocationPct: baselineState.entryEquityAllocationPct,
    targetCoreEquityPct: nextTargetCoreEquityPct,
    priorTargetCoreEquityPct: baselineState.targetCoreEquityPct,
    favorableSequenceWeeks: baselineState.favorableSequenceWeeks + 1,
    consecutiveStallWeeks: nextStallWeeks,
    lastRealizedEquityAllocationPct: currentEquityAllocationPct,
    lastRequestedExposureDeltaUsd: requestedExposureDeltaUsd,
    lastRealizedExposureDeltaPct: realizedProgressPct,
    lastAction: nextAction,
    lastReason: nextReason
  };

  return {
    active: true,
    state,
    targetCoreEquityPct: nextTargetCoreEquityPct,
    targetCoreEquityUsd,
    effectiveCeilingPct,
    requestedExposureDeltaPct,
    requestedExposureDeltaUsd,
    controllerAction: nextAction,
    controllerReason: nextReason,
    minimumExecutableDeltaUsd
  };
};

export const computeFavorableStatePersistence = ({
  config,
  regimeLabel,
  timeInRegimeWeeks,
  currentEquityAllocationPct
}: FavorableStatePersistenceInput): FavorableStatePersistenceResult => {
  const policy = config.favorableStatePersistence;
  if (!policy || policy.mode !== 'risk_on_trim_buffer') {
    return {
      active: false,
      favorableSequenceWeeks: Math.max(0, timeInRegimeWeeks ?? 0),
      maxPersistentOverweightPct: 0,
      reason: 'disabled'
    };
  }

  if (regimeLabel !== 'risk_on') {
    return {
      active: false,
      favorableSequenceWeeks: Math.max(0, timeInRegimeWeeks ?? 0),
      maxPersistentOverweightPct: 0,
      reason: 'not_risk_on'
    };
  }

  const favorableSequenceWeeks = Math.max(0, timeInRegimeWeeks ?? 0);
  const minRiskOnWeeks = Math.max(1, policy.minRiskOnWeeks ?? 2);
  if (favorableSequenceWeeks < minRiskOnWeeks) {
    return {
      active: false,
      favorableSequenceWeeks,
      maxPersistentOverweightPct: 0,
      reason: 'insufficient_sequence'
    };
  }

  const lowEquityThreshold = Math.max(0, Math.min(1, policy.lowEquityAllocationThresholdPct ?? 0.4));
  if (currentEquityAllocationPct >= lowEquityThreshold) {
    return {
      active: false,
      favorableSequenceWeeks,
      maxPersistentOverweightPct: 0,
      reason: 'not_underinvested'
    };
  }

  return {
    active: true,
    favorableSequenceWeeks,
    maxPersistentOverweightPct: Math.max(0, policy.maxPersistentOverweightPct ?? 0.08),
    reason: 'active'
  };
};
