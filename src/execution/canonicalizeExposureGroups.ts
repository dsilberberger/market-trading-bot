import { BotConfig, SleevePositions, TradeOrder } from '../core/types';
import { ExposureGroups, canonicalSymbolForExposure, symbolToExposureKey } from '../core/exposureGroups';

interface CanonicalizeInput {
  exposureGroups: ExposureGroups;
  holdings: Array<{ symbol: string; quantity: number }>;
  prices: Record<string, number>;
  sleevePositions?: SleevePositions;
  config: BotConfig;
  phase: string;
  protectFromSells: boolean;
  protectedSymbols?: string[];
  equity: number;
  corePoolUsd?: number;
  deployBudgetUsd?: number;
  remainingDeployBudgetUsd?: number;
  spentByBaseRebalanceBuysUsd?: number;
}

export const planCanonicalization = ({
  exposureGroups,
  holdings,
  prices,
  sleevePositions,
  config,
  phase,
  protectFromSells,
  protectedSymbols = [],
  equity,
  corePoolUsd,
  deployBudgetUsd,
  remainingDeployBudgetUsd,
  spentByBaseRebalanceBuysUsd
}: CanonicalizeInput) => {
  const flags: Array<{ code: string; severity: 'info' | 'warn'; message: string; observed?: any }> = [];
  const orders: TradeOrder[] = [];
  const allowedPhase =
    config.canonicalizeExposureGroups &&
    (config.canonicalizeOnlyInPhase || ['REINTEGRATE']).includes(phase || '');
  if (!allowedPhase) return { orders, flags };

  const capNotional = (config.canonicalizeMaxNotionalPctPerRun ?? 0.1) * equity;
  let remainingCap = capNotional;
  const budgetRail = typeof remainingDeployBudgetUsd === 'number' ? remainingDeployBudgetUsd : Infinity;
  const poolRail = typeof corePoolUsd === 'number' ? corePoolUsd : Infinity;
  let remainingBudget = Math.min(remainingCap, budgetRail, poolRail);
  const minDrift = config.canonicalizeMinDriftToAct ?? 0.05;
  const onlyIfAffordable = config.canonicalizeOnlyIfAffordable ?? true;
  const protectedSet = new Set(protectedSymbols);
  let budgetUsedUsd = 0;

  const grouped: Record<string, { nonCanonical: Array<{ symbol: string; qty: number }>; canonicalQty: number }> = {};
  for (const h of holdings) {
    const key = symbolToExposureKey(exposureGroups, h.symbol) || h.symbol;
    const canonical = canonicalSymbolForExposure(exposureGroups, key, prices, onlyIfAffordable);
    if (!grouped[key]) grouped[key] = { nonCanonical: [], canonicalQty: 0 };
    if (h.symbol === canonical) grouped[key].canonicalQty += h.quantity;
    else grouped[key].nonCanonical.push({ symbol: h.symbol, qty: h.quantity });
  }

  for (const [key, data] of Object.entries(grouped)) {
    const canonical = canonicalSymbolForExposure(exposureGroups, key, prices, onlyIfAffordable);
    if (!canonical) continue;
    if (!data.nonCanonical.length) continue;
    // Skip if canonical already substantial (drift check)
    const totalQty = data.canonicalQty + data.nonCanonical.reduce((a, n) => a + n.qty, 0);
    const canonicalWeight = totalQty ? data.canonicalQty / totalQty : 0;
    if (canonicalWeight >= 1 - minDrift) continue;

    for (const n of data.nonCanonical) {
      if (remainingBudget <= 0) {
        flags.push({
          code: 'CANONICALIZATION_SKIPPED_BUDGET',
          severity: 'info',
          message: `Budget exhausted; skipping further canonicalization.`,
          observed: { exposure: key, remainingBudgetUsd: remainingBudget }
        });
        break;
      }
      const pxSell = prices[n.symbol] || 0;
      const pxBuy = prices[canonical] || 0;
      if (pxSell <= 0 || pxBuy <= 0) continue;
      const sleeve = sleevePositions?.[n.symbol];
      const baseQty = sleeve ? sleeve.baseQty || 0 : n.qty;
      const dislocQty = sleeve ? sleeve.dislocationQty || 0 : 0;
      let sellable = baseQty;
      if (protectFromSells && protectedSet.has(n.symbol)) {
        sellable = baseQty;
      } else {
        sellable = baseQty + (protectFromSells ? 0 : dislocQty);
      }
      if (sellable <= 0) continue;
      const maxQtyByCap = Math.floor(remainingCap / pxSell);
      const qtyToSell = Math.min(sellable, maxQtyByCap);
      if (qtyToSell <= 0) continue;
      const proceeds = qtyToSell * pxSell;
      let qtyToBuy = Math.floor(proceeds / pxBuy);
      if (qtyToBuy <= 0) continue;
      const buyNotional = qtyToBuy * pxBuy;
      if (buyNotional > remainingBudget) {
        qtyToBuy = Math.floor(remainingBudget / pxBuy);
      }
      if (qtyToBuy <= 0) {
        flags.push({
          code: 'CANONICALIZATION_SKIPPED_BUDGET',
          severity: 'info',
          message: `Budget limit reached; cannot buy canonical ${canonical}.`,
          observed: { exposure: key, remainingBudgetUsd: remainingBudget, stage: 'CANONICALIZE' }
        });
        continue;
      }
      const adjustedBuyNotional = qtyToBuy * pxBuy;
      const adjustedSellNotional = qtyToSell * pxSell;
      remainingCap = Math.max(0, remainingCap - adjustedSellNotional);
      remainingBudget = Math.max(0, remainingBudget - adjustedBuyNotional);
      budgetUsedUsd += adjustedBuyNotional;
      orders.push({
        symbol: n.symbol,
        side: 'SELL',
        orderType: 'MARKET',
        notionalUSD: adjustedSellNotional,
        thesis: 'Canonicalization sell non-canonical member.',
        invalidation: '',
        confidence: 0.8,
        portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
      });
      orders.push({
        symbol: canonical,
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: adjustedBuyNotional,
        thesis: 'Canonicalization buy preferred member.',
        invalidation: '',
        confidence: 0.8,
        portfolioLevel: { targetHoldDays: 0, netExposureTarget: 1 }
      });
      flags.push({
        code: 'CANONICALIZATION_PLANNED',
        severity: 'info',
        message: `Convert ${n.symbol} -> ${canonical}`,
        observed: {
          exposure: key,
          qtySell: qtyToSell,
          qtyBuy: qtyToBuy,
          stage: 'CANONICALIZE',
          budgetUsedUsd: budgetUsedUsd,
          budgetRemainingUsd: remainingBudget,
          baseAllowedInvestUsd: deployBudgetUsd ?? null,
          spentByBaseRebalanceBuysUsd: spentByBaseRebalanceBuysUsd ?? null,
          remainingBaseDeployBudgetUsdBefore: remainingBudget + adjustedBuyNotional,
          remainingBaseDeployBudgetUsdAfter: remainingBudget,
          maxSharesByDeployBudget: Math.floor((remainingBudget + adjustedBuyNotional) / pxBuy),
          buyNotionalUsd: adjustedBuyNotional
        }
      });
    }
  }

  return { orders, flags };
};
