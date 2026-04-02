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
