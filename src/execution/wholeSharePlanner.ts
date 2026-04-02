import { TradeOrder } from '../core/types';
import { ExposureGroups, symbolToExposureKey } from '../core/exposureGroups';

export interface TargetInput {
  symbol: string;
  weight?: number;
  notionalUSD?: number;
  priority?: number;
  proxyList?: string[];
}

interface Candidate {
  originalSymbol: string;
  symbol: string;
  price: number;
  targetWeight: number;
  priority?: number;
  weight?: number;
}

export type WholeSharePlannerMode = 'baseline' | 'subset_optimized' | 'subset_optimized_refined' | 'subset_optimized_composition';

export interface ExecutionPlanOrder {
  symbol: string;
  originalSymbol?: string;
  side: 'BUY';
  quantity: number;
  estNotionalUSD: number;
  estPrice: number;
  thesis?: string;
  invalidation?: string;
  confidence?: number;
  exposureKey?: string;
}

export interface ExecutionSubstitution {
  originalSymbol: string;
  executedSymbol: string;
  reason: 'ORIGINAL' | 'PROXY_SUBSTITUTION' | 'DROPPED_UNEXECUTABLE';
  priceOriginal?: number;
  priceExecuted?: number;
  targetWeight?: number;
  proxyTried?: string[];
}

export interface ExecutionPlan {
  status: 'OK' | 'PARTIAL' | 'UNEXECUTABLE';
  selectedSymbols: string[];
  orders: ExecutionPlanOrder[];
  achievedWeights: Record<string, number>;
  targetWeights: Record<string, number>;
  leftoverCashUSD: number;
  error: { maxAbsError: number; l1Error: number };
  skipped: Array<{ symbol: string; reason: string; price?: number; targetWeight?: number }>;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: Record<string, unknown> }>;
  substitutions: ExecutionSubstitution[];
}

interface PlannerParams {
  targets: TargetInput[];
  prices: Record<string, number>;
  buyBudgetUSD: number;
  minCashUSD: number;
  allowPartial: boolean;
  minViablePositions: number;
  maxAbsWeightError: number;
  proxyMap?: Record<string, string[]>;
  allowProxies?: boolean;
  maxProxyTrackingErrorAbs?: number;
  proxyCascade?: boolean;
  exposureGroups?: ExposureGroups;
  allowRemainder?: boolean; // optional gate for largest-remainder pass
  mode?: WholeSharePlannerMode;
}

interface BaseEtfPlannerParams extends PlannerParams {
  regimeLabel?: string;
  timeInRegimeWeeks?: number;
}

const normalizeWeights = (targets: TargetInput[]) => {
  let weights: Record<string, number> = {};
  let total = 0;
  const first = targets.find((t) => t.weight !== undefined);
  if (first) {
    total = targets.reduce((acc, t) => acc + (t.weight || 0), 0);
    if (total <= 0) return {};
    weights = Object.fromEntries(targets.map((t) => [t.symbol, (t.weight || 0) / total]));
  } else {
    total = targets.reduce((acc, t) => acc + (t.notionalUSD || 0), 0);
    if (total <= 0) return {};
    weights = Object.fromEntries(targets.map((t) => [t.symbol, (t.notionalUSD || 0) / total]));
  }
  return weights;
};

interface CandidateAllocationResult {
  status: ExecutionPlan['status'];
  selectedSymbols: string[];
  orders: ExecutionPlanOrder[];
  achievedWeights: Record<string, number>;
  targetWeights: Record<string, number>;
  leftoverCashUSD: number;
  error: { maxAbsError: number; l1Error: number };
  flags: ExecutionPlan['flags'];
}

interface CandidatePlanScore {
  fullTargetL1Error: number;
  fullTargetMaxAbsError: number;
  leftoverCashUSD: number;
  investedUsd: number;
  fundedSymbolCount: number;
  maxAchievedWeight: number;
  omittedEquityCount: number;
  omittedEquityTargetWeight: number;
  selectedKey: string;
}

const REFINED_SUBSET_L1_FIT_BAND = 0.05;
const COMPOSITION_SUBSET_L1_FIT_BAND = 0.05;
const COMPOSITION_SUBSET_INVESTED_BAND_USD = 20;

const isEquityExposureKey = (key?: string) => Boolean(key && key.includes('EQUITY'));

const allocateCandidatePlan = ({
  candidates: inputCandidates,
  budget,
  allowPartial,
  minViablePositions,
  maxAbsWeightError,
  allowRemainder
}: {
  candidates: Candidate[];
  budget: number;
  allowPartial: boolean;
  minViablePositions: number;
  maxAbsWeightError: number;
  allowRemainder?: boolean;
}): CandidateAllocationResult | null => {
  if (!inputCandidates.length || inputCandidates.length < minViablePositions) return null;

  let candidates = [...inputCandidates];
  const weightSum = candidates.reduce((acc, t) => acc + (t.targetWeight || 0), 0);
  candidates = candidates.map((c) => ({ ...c, weight: weightSum ? (c.targetWeight || 0) / weightSum : 0 }));

  const calcCost = (list: Candidate[], shareArr: number[]) =>
    shareArr.reduce((acc, s, i) => acc + s * (list[i]?.price || 0), 0);

  let shares = candidates.map((c) => {
    const targetUSD = (c.weight || 0) * budget;
    return Math.max(0, Math.floor(targetUSD / c.price));
  });

  const ensureMinPositions = () => {
    let active = shares.filter((s) => s > 0).length;
    if (active >= minViablePositions) return;
    const sortedByPrice = candidates
      .map((c, i) => ({ ...c, idx: i }))
      .sort((a, b) => (a.price || 0) - (b.price || 0));
    for (const c of sortedByPrice) {
      if (active >= minViablePositions) break;
      if (shares[c.idx] > 0) continue;
      const newCost = calcCost(candidates, shares.map((s, i) => (i === c.idx ? 1 : s)));
      if (newCost <= budget) {
        shares[c.idx] = 1;
        active += 1;
      }
    }
  };
  ensureMinPositions();

  let currentCost = calcCost(candidates, shares);
  if (currentCost > budget) {
    while (currentCost > budget) {
      const reducible = shares
        .map((s, i) => ({
          idx: i,
          shares: s,
          price: candidates[i]?.price || 0,
          overTarget: s * (candidates[i]?.price || 0) - (candidates[i]?.weight || 0) * budget
        }))
        .filter((x) => x.shares > 1)
        .sort((a, b) => (b.overTarget || 0) - (a.overTarget || 0))[0];
      if (!reducible) break;
      shares[reducible.idx] -= 1;
      currentCost = calcCost(candidates, shares);
    }
    if (currentCost > budget) {
      const sorted = candidates
        .map((c, i) => ({ ...c, idx: i }))
        .sort((a, b) => (a.weight || 0) - (b.weight || 0));
      let kept = [...candidates];
      for (const drop of sorted) {
        kept = kept.filter((_, i) => i !== drop.idx);
        if (kept.length < minViablePositions) break;
        const keptWeightTotal = kept.reduce((acc, t) => acc + (t.weight || 0), 0);
        shares = kept.map((c) => Math.max(1, Math.floor(((c.weight || 0) / keptWeightTotal) * budget / c.price)));
        currentCost = calcCost(kept, shares);
        if (currentCost <= budget && kept.length >= minViablePositions) {
          candidates = kept;
          break;
        }
      }
    }
  }

  let spent = calcCost(candidates, shares);
  let leftover = budget - spent;
  if (allowRemainder !== false && candidates.length) {
    const remainderFor = (i: number, shareArr: number[]) =>
      (candidates[i].weight || 0) * budget - shareArr[i] * (candidates[i].price || 0);
    const minAffordablePrice = () =>
      Math.min(
        ...candidates
          .map((c) => c.price || Infinity)
          .filter((p) => Number.isFinite(p) && p > 0)
      );

    while (leftover >= minAffordablePrice() - 1e-9) {
      const ranked = candidates
        .map((c, i) => ({ idx: i, remainderUSD: remainderFor(i, shares), price: c.price || 0, symbol: c.symbol }))
        .filter((x) => x.price > 0 && x.remainderUSD > 0 && x.price <= leftover + 1e-9)
        .sort((a, b) => (b.remainderUSD === a.remainderUSD ? a.symbol.localeCompare(b.symbol) : b.remainderUSD - a.remainderUSD));
      if (!ranked.length) break;
      const pick = ranked[0];
      shares[pick.idx] += 1;
      spent += pick.price;
      leftover = budget - spent;
    }
  }

  const orders: ExecutionPlanOrder[] = candidates.map((c, i) => ({
    symbol: c.symbol,
    side: 'BUY',
    quantity: shares[i],
    estNotionalUSD: shares[i] * (c.price || 0),
    estPrice: c.price || 0
  }));
  const invested = orders.reduce((acc, o) => acc + o.estNotionalUSD, 0);
  const achievedWeights: Record<string, number> = {};
  orders.forEach((o) => {
    achievedWeights[o.symbol] = invested > 0 ? o.estNotionalUSD / invested : 0;
  });
  const targetWts = candidates.reduce((acc, c) => ({ ...acc, [c.symbol]: c.weight || 0 }), {} as Record<string, number>);
  const errors = candidates.map((c) => Math.abs((achievedWeights[c.symbol] || 0) - (c.weight || 0)));
  const maxAbsError = errors.length ? Math.max(...errors) : 0;
  const l1Error = errors.reduce((acc, e) => acc + e, 0);

  let status: ExecutionPlan['status'] = 'OK';
  const flags: ExecutionPlan['flags'] = [];
  if (maxAbsError > maxAbsWeightError) {
    status = allowPartial ? 'PARTIAL' : 'UNEXECUTABLE';
    flags.push({
      code: 'WEIGHT_TRACKING_ERROR_HIGH',
      severity: status === 'PARTIAL' ? 'warn' : 'error',
      message: `Max abs weight error ${maxAbsError.toFixed(4)} exceeds ${maxAbsWeightError.toFixed(4)}`,
      observed: { maxAbsError, l1Error }
    });
  }

  return {
    status,
    selectedSymbols: candidates.map((c) => c.symbol),
    orders,
    achievedWeights,
    targetWeights: targetWts,
    leftoverCashUSD: leftover,
    error: { maxAbsError, l1Error },
    flags
  };
};

const buildFullTargetScore = ({
  plan,
  originalTargetWeights,
  exposureGroups
}: {
  plan: CandidateAllocationResult;
  originalTargetWeights: Record<string, number>;
  exposureGroups?: ExposureGroups;
}): CandidatePlanScore => {
  const symbols = Array.from(new Set([...Object.keys(originalTargetWeights), ...Object.keys(plan.achievedWeights)])).sort();
  const absErrors = symbols.map((symbol) => Math.abs((plan.achievedWeights[symbol] || 0) - (originalTargetWeights[symbol] || 0)));
  const investedUsd = plan.orders.reduce((sum, order) => sum + (order.estNotionalUSD || 0), 0);
  const fundedSymbolCount = plan.orders.filter((order) => (order.quantity || 0) > 0).length;
  const selectedSymbols = new Set(plan.selectedSymbols);
  const omittedEquitySymbols = symbols.filter((symbol) => {
    if (selectedSymbols.has(symbol) || (originalTargetWeights[symbol] || 0) <= 0) return false;
    return isEquityExposureKey(symbolToExposureKey(exposureGroups || {}, symbol));
  });

  return {
    fullTargetL1Error: absErrors.reduce((sum, value) => sum + value, 0),
    fullTargetMaxAbsError: absErrors.length ? Math.max(...absErrors) : 0,
    leftoverCashUSD: plan.leftoverCashUSD,
    investedUsd,
    fundedSymbolCount,
    maxAchievedWeight: plan.selectedSymbols.reduce((maxWeight, symbol) => Math.max(maxWeight, plan.achievedWeights[symbol] || 0), 0),
    omittedEquityCount: omittedEquitySymbols.length,
    omittedEquityTargetWeight: omittedEquitySymbols.reduce((sum, symbol) => sum + (originalTargetWeights[symbol] || 0), 0),
    selectedKey: plan.selectedSymbols.join('|')
  };
};

const comparePlanScores = (
  left: CandidatePlanScore,
  right: CandidatePlanScore,
  mode: WholeSharePlannerMode = 'subset_optimized'
) => {
  if (mode === 'subset_optimized_composition') {
    const l1Gap = Math.abs(left.fullTargetL1Error - right.fullTargetL1Error);
    if (l1Gap > COMPOSITION_SUBSET_L1_FIT_BAND) return left.fullTargetL1Error - right.fullTargetL1Error;

    const investedGap = Math.abs(left.investedUsd - right.investedUsd);
    if (investedGap > COMPOSITION_SUBSET_INVESTED_BAND_USD) {
      if (left.leftoverCashUSD !== right.leftoverCashUSD) return left.leftoverCashUSD - right.leftoverCashUSD;
      if (left.investedUsd !== right.investedUsd) return right.investedUsd - left.investedUsd;
    }

    if (left.fundedSymbolCount !== right.fundedSymbolCount) return right.fundedSymbolCount - left.fundedSymbolCount;
    if ((left.fundedSymbolCount === 1) !== (right.fundedSymbolCount === 1)) {
      return left.fundedSymbolCount === 1 ? 1 : -1;
    }
    if (left.maxAchievedWeight !== right.maxAchievedWeight) return left.maxAchievedWeight - right.maxAchievedWeight;
    if (left.omittedEquityCount !== right.omittedEquityCount) return left.omittedEquityCount - right.omittedEquityCount;
    if (left.omittedEquityTargetWeight !== right.omittedEquityTargetWeight) {
      return left.omittedEquityTargetWeight - right.omittedEquityTargetWeight;
    }
    if (left.leftoverCashUSD !== right.leftoverCashUSD) return left.leftoverCashUSD - right.leftoverCashUSD;
    if (left.investedUsd !== right.investedUsd) return right.investedUsd - left.investedUsd;
    if (left.fullTargetMaxAbsError !== right.fullTargetMaxAbsError) {
      return left.fullTargetMaxAbsError - right.fullTargetMaxAbsError;
    }
    if (left.fullTargetL1Error !== right.fullTargetL1Error) return left.fullTargetL1Error - right.fullTargetL1Error;
    return left.selectedKey.localeCompare(right.selectedKey);
  }

  if (mode === 'subset_optimized_refined') {
    const l1Gap = Math.abs(left.fullTargetL1Error - right.fullTargetL1Error);
    if (l1Gap > REFINED_SUBSET_L1_FIT_BAND) return left.fullTargetL1Error - right.fullTargetL1Error;
    if (left.leftoverCashUSD !== right.leftoverCashUSD) return left.leftoverCashUSD - right.leftoverCashUSD;
    if (left.investedUsd !== right.investedUsd) return right.investedUsd - left.investedUsd;
    if (left.omittedEquityCount !== right.omittedEquityCount) return left.omittedEquityCount - right.omittedEquityCount;
    if (left.omittedEquityTargetWeight !== right.omittedEquityTargetWeight) {
      return left.omittedEquityTargetWeight - right.omittedEquityTargetWeight;
    }
    if (left.fullTargetMaxAbsError !== right.fullTargetMaxAbsError) {
      return left.fullTargetMaxAbsError - right.fullTargetMaxAbsError;
    }
    if (left.fullTargetL1Error !== right.fullTargetL1Error) return left.fullTargetL1Error - right.fullTargetL1Error;
    if (left.fundedSymbolCount !== right.fundedSymbolCount) return right.fundedSymbolCount - left.fundedSymbolCount;
    return left.selectedKey.localeCompare(right.selectedKey);
  }

  if (left.fullTargetL1Error !== right.fullTargetL1Error) return left.fullTargetL1Error - right.fullTargetL1Error;
  if (left.fullTargetMaxAbsError !== right.fullTargetMaxAbsError) return left.fullTargetMaxAbsError - right.fullTargetMaxAbsError;
  if (left.leftoverCashUSD !== right.leftoverCashUSD) return left.leftoverCashUSD - right.leftoverCashUSD;
  if (left.investedUsd !== right.investedUsd) return right.investedUsd - left.investedUsd;
  if (left.fundedSymbolCount !== right.fundedSymbolCount) return right.fundedSymbolCount - left.fundedSymbolCount;
  return left.selectedKey.localeCompare(right.selectedKey);
};

export const planWholeShareExecution = ({
  targets,
  prices,
  buyBudgetUSD,
  minCashUSD,
  allowPartial,
  minViablePositions,
  maxAbsWeightError,
  proxyMap,
  allowProxies,
  maxProxyTrackingErrorAbs,
  proxyCascade,
  exposureGroups,
  allowRemainder,
  mode = 'baseline'
}: PlannerParams): ExecutionPlan => {
  const flags: ExecutionPlan['flags'] = [];
  const skipped: ExecutionPlan['skipped'] = [];
  const substitutions: ExecutionSubstitution[] = [];
  const targetWeights = normalizeWeights(targets);
  if (!Object.keys(targetWeights).length) {
    return {
      status: 'UNEXECUTABLE',
      selectedSymbols: [],
      orders: [],
      achievedWeights: {},
      targetWeights: {},
      leftoverCashUSD: buyBudgetUSD,
      error: { maxAbsError: 1, l1Error: 1 },
      skipped,
      flags: [
        {
          code: 'NO_WEIGHTS',
          severity: 'error',
          message: 'No valid target weights/notionals'
        }
      ],
      substitutions
    };
  }

  const budget = Math.max(0, buyBudgetUSD - minCashUSD);
  let candidates: Candidate[] = targets.map((t) => {
    const sym = t.symbol;
    const price = prices[sym];
    const tw = targetWeights[sym] ?? 0;
    let resolvedSym = sym;
    let resolvedPrice = price;
    let reason: ExecutionSubstitution['reason'] = 'ORIGINAL';
    if (allowProxies && proxyMap?.[sym]) {
      const proxyList = proxyMap[sym] || [];
      const proxy = proxyList.find((p) => prices[p] && prices[p] > 0);
      if ((!price || price <= 0) && proxy) {
        resolvedSym = proxy;
        resolvedPrice = prices[proxy];
        reason = 'PROXY_SUBSTITUTION';
        flags.push({
          code: 'PROXY_SUBSTITUTED',
          severity: 'info',
          message: `Substituted ${sym} with proxy ${proxy} due to missing price`,
          observed: { symbol: sym, proxy, priceFrom: price, priceTo: resolvedPrice }
        });
      }
    }
    substitutions.push({
      originalSymbol: sym,
      executedSymbol: resolvedSym,
      reason,
      priceOriginal: price,
      priceExecuted: resolvedPrice,
      targetWeight: tw
    });
    return {
      originalSymbol: sym,
      symbol: resolvedSym,
      price: resolvedPrice || 0,
      targetWeight: tw,
      priority: t.priority
    };
  });

  const dropUnaffordable = (list: Candidate[]) => {
    let sorted = [...list].sort((a, b) => (b.priority ?? b.weight ?? 0) - (a.priority ?? a.weight ?? 0));
    while (sorted.length) {
      const minCost = sorted.reduce((acc, t) => acc + (t.price || 0), 0);
      if (minCost <= budget) break;
      const dropped = sorted.pop();
      if (!dropped) break;
      skipped.push({
        symbol: dropped.symbol,
        reason: 'DROPPED_FOR_AFFORDABILITY',
        price: dropped.price,
        targetWeight: dropped.targetWeight
      });
      flags.push({
        code: 'DROPPED_FOR_AFFORDABILITY',
        severity: 'info',
        message: `Dropped ${dropped.symbol}; cannot afford 1 share per symbol within budget`,
        observed: { symbol: dropped.symbol, budget, price: dropped.price }
      });
    }
    return sorted;
  };

  candidates = candidates.filter((c) => c.price && c.price > 0);

  // If initial min-cost exceeds budget, attempt proxy substitution for affordability.
  const attemptProxyAffordability = () => {
    if (!allowProxies || !proxyMap) return;
    let totalMinCost = candidates.reduce((acc, c) => acc + (c.price || 0), 0);
    if (totalMinCost <= budget) return;

    const withSavings = candidates
      .map((c, idx) => {
        const proxyList = proxyMap?.[c.originalSymbol] || [];
        const cheaper = proxyList
          .map((p) => ({ proxy: p, price: prices[p] }))
          .filter((p) => p.price && p.price > 0 && p.price < c.price)
          .sort((a, b) => (a.price || 0) - (b.price || 0))[0];
        if (!cheaper) return null;
        return { idx, candidate: c, cheaper, savings: (c.price || 0) - (cheaper.price || 0) };
      })
      .filter(Boolean)
      .sort((a, b) => (b?.savings || 0) - (a?.savings || 0)) as Array<{
      idx: number;
      candidate: Candidate;
      cheaper: { proxy: string; price: number };
      savings: number;
    }>;

    for (const item of withSavings) {
      if (totalMinCost <= budget) break;
      const { idx, candidate: c, cheaper } = item;
      totalMinCost -= (c.price || 0) - (cheaper.price || 0);
      const proxy = cheaper.proxy;
      flags.push({
        code: 'PROXY_SUBSTITUTED',
        severity: 'info',
        message: `Substituted ${c.symbol} with proxy ${proxy} to fit budget`,
        observed: { symbol: c.symbol, proxy, priceFrom: c.price, priceTo: cheaper.price }
      });
      const subIdx = substitutions.findIndex((s) => s.originalSymbol === c.originalSymbol);
      if (subIdx >= 0) {
        substitutions[subIdx] = {
          originalSymbol: c.originalSymbol,
          executedSymbol: proxy,
          reason: 'PROXY_SUBSTITUTION',
          priceOriginal: substitutions[subIdx].priceOriginal ?? c.price,
          priceExecuted: cheaper.price,
          targetWeight: substitutions[subIdx].targetWeight,
          proxyTried: substitutions[subIdx].proxyTried
        };
      } else {
        substitutions.push({
          originalSymbol: c.originalSymbol,
          executedSymbol: proxy,
          reason: 'PROXY_SUBSTITUTION',
          priceOriginal: c.price,
          priceExecuted: cheaper.price,
          targetWeight: c.targetWeight
        });
      }
      candidates[idx] = { ...c, symbol: proxy, price: cheaper.price };
    }
  };

  attemptProxyAffordability();

  candidates = candidates.filter((c) => c.price && c.price > 0);
  const initialMinCost = candidates.reduce((acc, t) => acc + (t.price || 0), 0);
  if ((mode === 'subset_optimized' || mode === 'subset_optimized_refined' || mode === 'subset_optimized_composition') && initialMinCost > budget && candidates.length) {
    let best:
      | {
          candidates: Candidate[];
          plan: CandidateAllocationResult;
          score: CandidatePlanScore;
        }
      | undefined;

    const totalMasks = 1 << candidates.length;
    for (let mask = 1; mask < totalMasks; mask++) {
      const subset = candidates.filter((_, idx) => ((mask >> idx) & 1) === 1);
      if (subset.length < minViablePositions) continue;
      const subsetMinCost = subset.reduce((acc, item) => acc + (item.price || 0), 0);
      if (subsetMinCost > budget + 1e-9) continue;
      const candidatePlan = allocateCandidatePlan({
        candidates: subset,
        budget,
        allowPartial,
        minViablePositions,
        maxAbsWeightError,
        allowRemainder
      });
      if (!candidatePlan) continue;
      if (candidatePlan.orders.every((order) => (order.quantity || 0) <= 0)) continue;
      const score = buildFullTargetScore({ plan: candidatePlan, originalTargetWeights: targetWeights, exposureGroups });
      if (!best || comparePlanScores(score, best.score, mode) < 0) {
        best = { candidates: subset, plan: candidatePlan, score };
      }
    }

    if (best) {
      const selectedSymbols = new Set(best.candidates.map((candidate) => candidate.symbol));
      candidates
        .filter((candidate) => !selectedSymbols.has(candidate.symbol))
        .forEach((candidate) => {
          skipped.push({
            symbol: candidate.symbol,
            reason: 'DROPPED_FOR_AFFORDABILITY_OPTIMIZED_SUBSET',
            price: candidate.price,
            targetWeight: candidate.targetWeight
          });
        });
      flags.push({
        code: 'AFFORDABLE_SUBSET_OPTIMIZED',
        severity: 'info',
        message: 'Selected an affordable whole-share subset that best fits the original target basket',
        observed: {
          originalSymbolCount: candidates.length,
          selectedSymbolCount: best.candidates.length,
          fullTargetL1Error: best.score.fullTargetL1Error,
          fullTargetMaxAbsError: best.score.fullTargetMaxAbsError,
          leftoverCashUSD: best.score.leftoverCashUSD
        }
      });
      candidates = best.candidates;
    } else {
      candidates = [];
    }
  } else {
    candidates = dropUnaffordable(candidates);
  }

  if (!candidates.length || candidates.length < minViablePositions) {
    return {
      status: 'UNEXECUTABLE',
      selectedSymbols: [],
      orders: [],
      achievedWeights: {},
      targetWeights,
      leftoverCashUSD: buyBudgetUSD,
      error: { maxAbsError: 1, l1Error: 1 },
      skipped,
      flags: [
        ...flags,
        {
          code: 'CANNOT_AFFORD_ONE_SHARE_EACH',
          severity: 'error',
          message: 'Cannot afford minimum viable positions',
          observed: { budget, minViablePositions }
        }
      ],
      substitutions
    };
  }

  const feasible = (set: any[]) => set.reduce((acc, t) => acc + t.price, 0) <= budget;
  if (!feasible(candidates)) {
    candidates = dropUnaffordable(candidates);
  }
  if (!candidates.length || candidates.length < minViablePositions) {
    return {
      status: 'UNEXECUTABLE',
      selectedSymbols: [],
      orders: [],
      achievedWeights: {},
      targetWeights,
      leftoverCashUSD: buyBudgetUSD,
      error: { maxAbsError: 1, l1Error: 1 },
      skipped,
      flags: [
        ...flags,
        {
          code: 'CANNOT_AFFORD_ONE_SHARE_EACH',
          severity: 'error',
          message: 'Cannot afford minimum viable positions',
          observed: { budget, minViablePositions }
        }
      ],
      substitutions
    };
  }

  const allocation = allocateCandidatePlan({
    candidates,
    budget,
    allowPartial,
    minViablePositions,
    maxAbsWeightError,
    allowRemainder
  });
  if (!allocation) {
    return {
      status: 'UNEXECUTABLE',
      selectedSymbols: [],
      orders: [],
      achievedWeights: {},
      targetWeights,
      leftoverCashUSD: buyBudgetUSD,
      error: { maxAbsError: 1, l1Error: 1 },
      skipped,
      flags: [
        ...flags,
        {
          code: 'CANNOT_ALLOCATE_AFFORDABLE_BASKET',
          severity: 'error',
          message: 'Planner could not allocate a valid whole-share basket under the current budget',
          observed: { budget, candidateCount: candidates.length }
        }
      ],
      substitutions
    };
  }

  const orders = allocation.orders.map((order) => ({
    ...order,
    exposureKey: exposureGroups ? symbolToExposureKey(exposureGroups, order.symbol) : undefined
  }));

  return {
    status: allocation.status,
    selectedSymbols: allocation.selectedSymbols,
    orders,
    achievedWeights: allocation.achievedWeights,
    targetWeights: allocation.targetWeights,
    leftoverCashUSD: allocation.leftoverCashUSD,
    error: allocation.error,
    skipped,
    flags: [...flags, ...allocation.flags],
    substitutions
  };
};

export const planBaseEtfExecution = ({
  regimeLabel,
  timeInRegimeWeeks = 0,
  ...plannerParams
}: BaseEtfPlannerParams): ExecutionPlan => {
  if (regimeLabel === 'neutral') {
    const floorPlan = planWholeShareExecution({ ...plannerParams, allowRemainder: false });
    const candidatePlan = planWholeShareExecution({ ...plannerParams, allowRemainder: true });
    const maxAbsErrorDelta = candidatePlan.error.maxAbsError - floorPlan.error.maxAbsError;
    const l1ErrorDelta = candidatePlan.error.l1Error - floorPlan.error.l1Error;
    const candidateAccepted =
      candidatePlan.status === 'OK' &&
      candidatePlan.error.maxAbsError <= 0.05 &&
      maxAbsErrorDelta <= 0.01 &&
      l1ErrorDelta <= 0.02;
    return candidateAccepted ? candidatePlan : floorPlan;
  }

  const allowRemainder = regimeLabel === 'risk_on' && timeInRegimeWeeks >= 1;
  return planWholeShareExecution({ ...plannerParams, allowRemainder });
};
