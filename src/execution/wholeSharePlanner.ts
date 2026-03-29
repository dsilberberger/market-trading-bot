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
  allowRemainder
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

  const dropUnaffordable = (list: any[]) => {
    let sorted = [...list].sort((a, b) => (b.priority ?? b.weight ?? 0) - (a.priority ?? a.weight ?? 0));
    while (sorted.length) {
      const minCost = sorted.reduce((acc, t) => acc + (t.price || 0), 0);
      if (minCost <= budget) break;
      const dropped = sorted.pop();
      skipped.push({
        symbol: dropped.symbol,
        reason: 'DROPPED_FOR_AFFORDABILITY',
        price: dropped.price,
        targetWeight: targetWeights[dropped.symbol]
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
  candidates = dropUnaffordable(candidates);

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

  // normalize weights for remaining based on targetWeight carried forward
  const weightSum = candidates.reduce((acc, t) => acc + (t.targetWeight || 0), 0);
  candidates = candidates.map((c) => ({ ...c, weight: weightSum ? (c.targetWeight || 0) / weightSum : 0 }));

  const calcCost = (list: Candidate[], shareArr: number[]) =>
    shareArr.reduce((acc, s, i) => acc + s * (list[i]?.price || 0), 0);

  // Initial allocation: floor target USD per symbol, do not force a share that blows past target.
  let shares = candidates.map((c) => {
    const targetUSD = (c.weight || 0) * budget;
    return Math.max(0, Math.floor(targetUSD / c.price));
  });

  // If we cannot meet minimum viable positions, bump cheapest symbols up to 1 share while budget allows.
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
    // First, reduce excess shares (while keeping at least 1 of each) before dropping symbols.
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
    // If still above budget, fall back to dropping lowest-weight symbols.
    if (currentCost > budget) {
      const sorted = candidates
        .map((c, i) => ({ ...c, idx: i }))
        .sort((a, b) => (a.weight || 0) - (b.weight || 0));
      let kept = [...candidates];
      for (const drop of sorted) {
        kept = kept.filter((_, i) => i !== drop.idx);
        const weightTotal = kept.reduce((acc, t) => acc + (t.weight || 0), 0);
        shares = kept.map((c) => Math.max(1, Math.floor(((c.weight || 0) / weightTotal) * budget / c.price)));
        currentCost = calcCost(kept, shares);
        if (currentCost <= budget && kept.length >= minViablePositions) {
          candidates = kept;
          break;
        }
      }
    }
  }

  // largest remainder allocation (optional)
  let spent = calcCost(candidates, shares);
  let leftover = budget - spent;
  if (allowRemainder !== false) {
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
    estPrice: c.price || 0,
    exposureKey: exposureGroups ? symbolToExposureKey(exposureGroups, c.symbol) : undefined
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
    skipped,
    flags,
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
