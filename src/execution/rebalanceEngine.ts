import { BotConfig, PortfolioState, TradeOrder } from '../core/types';
import { ExecutionPlan } from './wholeSharePlanner';

export interface RebalanceInput {
  asOf: string;
  portfolio: PortfolioState;
  prices: Record<string, number>;
  targetPlan: ExecutionPlan;
  regimes?: any;
  priorRegimes?: any;
  proxyParentMap?: Record<string, string>;
  config: BotConfig;
}

export interface RebalanceResult {
  status: 'OK' | 'SKIPPED_NO_DRIFT' | 'SKIPPED_NO_CHANGES' | 'UNEXECUTABLE';
  sellOrders: TradeOrder[];
  buyOrders: TradeOrder[];
  combinedOrders: TradeOrder[];
  drift: {
    portfolio: { currentInvestedPct: number; targetInvestedPct: number; absDiff: number };
    positions: Record<string, { currentWeight: number; targetWeight: number; absDiff: number }>;
  };
  skipped: Array<{ symbol: string; reason: string; absDiff?: number }>;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

const toParent = (sym: string, proxyParentMap?: Record<string, string>) => proxyParentMap?.[sym] || sym;

const extractConfBucket = (v?: number) => {
  if (v === undefined || v === null) return 'mid';
  if (v < 0.35) return 'low';
  if (v < 0.6) return 'mid';
  return 'high';
};

export const rebalancePortfolio = ({
  asOf,
  portfolio,
  prices,
  targetPlan,
  regimes,
  priorRegimes,
  proxyParentMap,
  config
}: RebalanceInput): RebalanceResult => {
  const flags: RebalanceResult['flags'] = [];
  const skipped: RebalanceResult['skipped'] = [];
  if (!config.rebalance?.enabled) {
    return {
      status: 'SKIPPED_NO_CHANGES',
      sellOrders: [],
      buyOrders: [],
      combinedOrders: [],
      drift: {
        portfolio: { currentInvestedPct: 0, targetInvestedPct: 0, absDiff: 0 },
        positions: {}
      },
      skipped,
      flags: [
        { code: 'REBALANCE_DISABLED', severity: 'info', message: 'Rebalance disabled in config.' }
      ]
    };
  }

  const dustShares = config.rebalance.rebalanceDustSharesThreshold ?? 0;
  const posDriftTh = config.rebalance.positionDriftThreshold ?? 0.05;
  const pfDriftTh = config.rebalance.portfolioDriftThreshold ?? 0.05;
  const minTrade = config.rebalance.minTradeNotionalUSD ?? 0;

  // Build current state aggregated by parent symbol
  const currentValueByParent: Record<string, number> = {};
  const currentQtyByParent: Record<string, number> = {};
  for (const h of portfolio.holdings || []) {
    const parent = toParent(h.symbol, proxyParentMap);
    const px = prices[h.symbol] ?? prices[parent] ?? 0;
    currentValueByParent[parent] = (currentValueByParent[parent] || 0) + h.quantity * px;
    currentQtyByParent[parent] = (currentQtyByParent[parent] || 0) + h.quantity;
  }
  const currentInvested = Object.values(currentValueByParent).reduce((a, b) => a + b, 0);
  const totalEquity = portfolio.cash + currentInvested;
  const currentInvestedPct = totalEquity > 0 ? currentInvested / totalEquity : 0;

  // Target from execution plan (executed symbols -> parent)
  const targetValueByParent: Record<string, number> = {};
  const targetQtyByParent: Record<string, number> = {};
  const executedSymbolByParent: Record<string, string> = {};
  for (const o of targetPlan.orders || []) {
    const parent = toParent(o.symbol, proxyParentMap);
    const px = prices[o.symbol] ?? prices[parent] ?? o.estPrice ?? 0;
    const val = o.quantity * px;
    targetValueByParent[parent] = (targetValueByParent[parent] || 0) + val;
    targetQtyByParent[parent] = (targetQtyByParent[parent] || 0) + o.quantity;
    executedSymbolByParent[parent] = o.symbol; // last wins, fine for our small sets
  }
  const targetInvested = Object.values(targetValueByParent).reduce((a, b) => a + b, 0);
  const targetInvestedPct = totalEquity > 0 ? targetInvested / totalEquity : 0;

  const portfolioAbsDiff = Math.abs(currentInvestedPct - targetInvestedPct);
  const positions: RebalanceResult['drift']['positions'] = {};
  const allParents = Array.from(new Set([...Object.keys(currentValueByParent), ...Object.keys(targetValueByParent)]));
  for (const p of allParents) {
    const cw = totalEquity > 0 ? (currentValueByParent[p] || 0) / totalEquity : 0;
    const tw = totalEquity > 0 ? (targetValueByParent[p] || 0) / totalEquity : 0;
    positions[p] = { currentWeight: cw, targetWeight: tw, absDiff: Math.abs(cw - tw) };
  }

  let regimeChange = false;
  if (config.rebalance.alwaysRebalanceOnRegimeChange && regimes) {
    const keys = config.rebalance.regimeChangeKeys || [];
    const getVal = (obj: any, path: string) => path.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), obj);
    for (const k of keys) {
      const curr = getVal(regimes, k);
      const prior = getVal(priorRegimes, k);
      if (curr !== undefined && prior !== undefined && curr !== prior) regimeChange = true;
    }
    // also bucket confidence changes
    const currBucket = extractConfBucket(regimes?.equityRegime?.confidence);
    const priorBucket = extractConfBucket(priorRegimes?.equityRegime?.confidence);
    if (currBucket !== priorBucket) regimeChange = true;
  }

  if (!regimeChange && portfolioAbsDiff < pfDriftTh) {
    const maxPosDrift = Math.max(...Object.values(positions).map((p) => p.absDiff), 0);
    if (maxPosDrift < posDriftTh) {
      return {
        status: 'SKIPPED_NO_DRIFT',
        sellOrders: [],
        buyOrders: [],
        combinedOrders: [],
        drift: {
          portfolio: { currentInvestedPct, targetInvestedPct, absDiff: portfolioAbsDiff },
          positions
        },
        skipped,
        flags: [
          {
            code: 'REBALANCE_SKIPPED_DRIFT',
            severity: 'info',
            message: 'Drift below thresholds; rebalance skipped',
            observed: { portfolioAbsDiff, maxPosDrift }
          }
        ]
      };
    }
  }

  const sellOrders: TradeOrder[] = [];
  const buyOrders: TradeOrder[] = [];
  // Sells: parents present in current > target
  for (const p of allParents) {
    const currQty = currentQtyByParent[p] || 0;
    const targetQty = targetQtyByParent[p] || 0;
    if (targetQty < currQty) {
      const delta = currQty - targetQty;
      if (delta <= dustShares) {
        skipped.push({ symbol: p, reason: 'DUST_THRESHOLD', absDiff: delta });
        continue;
      }
      const symToSell = executedSymbolByParent[p] || p;
      const px = prices[symToSell] ?? prices[p] ?? 0;
      const notion = delta * px;
      if (notion < minTrade) {
        skipped.push({ symbol: p, reason: 'MIN_TRADE_NOTIONAL', absDiff: delta });
        continue;
      }
      sellOrders.push({
        symbol: symToSell,
        side: 'SELL',
        orderType: 'MARKET',
        notionalUSD: notion,
        thesis: 'Rebalance trim to target weight.',
        invalidation: '',
        confidence: 1,
        portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
      });
    }
  }

  // Estimate cash after sells
  let cashAvail = portfolio.cash;
  for (const s of sellOrders) {
    cashAvail += s.notionalUSD;
  }

  // Buys: parents present in target > current
  for (const p of allParents) {
    const currQty = currentQtyByParent[p] || 0;
    const targetQty = targetQtyByParent[p] || 0;
    if (targetQty > currQty) {
      let delta = targetQty - currQty;
      const symToBuy = executedSymbolByParent[p] || p;
      const px = prices[symToBuy] ?? prices[p] ?? 0;
      if (px <= 0) continue;
      let notion = delta * px;
      if (notion < minTrade) {
        skipped.push({ symbol: p, reason: 'MIN_TRADE_NOTIONAL', absDiff: delta });
        continue;
      }
      if (notion > cashAvail) {
        const reduced = Math.floor(cashAvail / px);
        if (reduced <= 0) {
          skipped.push({ symbol: p, reason: 'INSUFFICIENT_CASH', absDiff: delta });
          continue;
        }
        delta = reduced;
        notion = delta * px;
      }
      cashAvail -= notion;
      buyOrders.push({
        symbol: symToBuy,
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: notion,
        thesis: 'Rebalance add to target weight.',
        invalidation: '',
        confidence: 0.6,
        portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
      });
    }
  }

  const combinedOrders = [...sellOrders, ...buyOrders];
  const status =
    combinedOrders.length === 0 ? 'SKIPPED_NO_CHANGES' : cashAvail < 0 ? 'UNEXECUTABLE' : 'OK';

  return {
    status,
    sellOrders,
    buyOrders,
    combinedOrders,
    drift: {
      portfolio: { currentInvestedPct, targetInvestedPct, absDiff: portfolioAbsDiff },
      positions
    },
    skipped,
    flags
  };
};
