import { ExecutionPlan, ExecutionPlanOrder } from './wholeSharePlanner';
import { BotConfig } from '../core/types';

interface DislocationPlannerInput {
  overlayTargets: Array<{ symbol: string; weight: number }>;
  overlayBudgetUSD: number;
  prices: Record<string, number>;
  maxSpendOverride?: number;
}

export const buildDislocationBuys = ({
  overlayTargets,
  overlayBudgetUSD,
  prices,
  maxSpendOverride
}: DislocationPlannerInput): ExecutionPlan => {
  const maxSpend = Math.max(0, maxSpendOverride !== undefined ? maxSpendOverride : overlayBudgetUSD);
  const targets = (overlayTargets || []).filter((t) => prices[t.symbol] && prices[t.symbol] > 0);
  if (!targets.length || maxSpend <= 0) {
    return {
      status: 'OK',
      selectedSymbols: [],
      orders: [],
      achievedWeights: {},
      targetWeights: {},
      leftoverCashUSD: maxSpend,
      error: { maxAbsError: 0, l1Error: 0 },
      skipped: [],
      flags: [],
      substitutions: []
    };
  }
  const totalWeight = targets.reduce((acc, t) => acc + (t.weight || 0), 0) || 1;
  const orders: ExecutionPlanOrder[] = [];
  let spent = 0;
  for (const t of targets) {
    const w = (t.weight || 0) / totalWeight;
    const alloc = maxSpend * w;
    const px = prices[t.symbol] || 0;
    if (px <= 0) continue;
    const qty = Math.floor(alloc / px);
    if (qty <= 0) continue;
    const notion = qty * px;
    spent += notion;
    orders.push({
      symbol: t.symbol,
      side: 'BUY',
      quantity: qty,
      estNotionalUSD: notion,
      estPrice: px,
      thesis: 'Opportunistic dislocation buy.',
      invalidation: '',
      confidence: 0.6
    });
  }
  return {
    status: 'OK',
    selectedSymbols: orders.map((o) => o.symbol),
    orders,
    achievedWeights: {},
    targetWeights: {},
    leftoverCashUSD: maxSpend - spent,
    error: { maxAbsError: 0, l1Error: 0 },
    skipped: [],
    flags: [],
    substitutions: []
  };
};
