import { BotConfig, PortfolioState, RiskReport, TradeIntent } from '../core/types';
import {
  countFuturePositions,
  hasShorting,
  insufficientCash,
  totalBuyNotional,
  totalSellNotional,
  totalAbsoluteNotional,
  violatesMaxTrades,
  violatesPositionSize,
  violatesUniverse,
  violatesTurnoverCap,
  violatesMinHold
} from './riskRules';

export interface RiskContext {
  drawdown: number;
}

export const evaluateRisk = (
  intent: TradeIntent,
  config: BotConfig,
  portfolio: PortfolioState,
  context: RiskContext
): RiskReport => {
  const blockedReasons: string[] = [];
  const adjustments: NonNullable<RiskReport['adjustments']> = [];
  let effectiveOrders = intent.orders;

  if (context.drawdown >= config.maxWeeklyDrawdownPct) {
    const retainedOrders = effectiveOrders.filter((order) => order.side !== 'BUY' || order.sleeve === 'dislocation');
    const removedBuyCount = effectiveOrders.filter((order) => order.side === 'BUY' && order.sleeve !== 'dislocation').length;
    effectiveOrders = retainedOrders;
    if (removedBuyCount > 0 && !effectiveOrders.length) {
      blockedReasons.push('Drawdown limit hit; buys blocked this week');
    }
  }

  const violations = violatesUniverse(effectiveOrders, intent.universe);
  if (violations.length) {
    blockedReasons.push(`Orders outside universe: ${violations.map((v) => v.symbol).join(', ')}`);
  }

  if (violatesMaxTrades(effectiveOrders, config.maxTradesPerRun)) {
    blockedReasons.push(`Too many trades: ${effectiveOrders.length} > ${config.maxTradesPerRun}`);
  }

  const positionCount = countFuturePositions(effectiveOrders, portfolio);
  if (positionCount > config.maxPositions) {
    blockedReasons.push(`Max positions exceeded: ${positionCount} > ${config.maxPositions}`);
  }

  const positionSizeMode = config.postPlanRisk?.positionSize?.mode || 'block';
  const requireFractionalSharesSupport = config.postPlanRisk?.positionSize?.requireFractionalSharesSupport ?? true;
  if (
    positionSizeMode === 'scale_to_limit' &&
    (!requireFractionalSharesSupport || config.fractionalSharesSupported !== false)
  ) {
    const maxPositionNotional = portfolio.equity * config.maxPositionPct;
    const heldNotionalBySymbol = new Map(
      portfolio.holdings.map((holding) => [holding.symbol, holding.quantity * (holding.avgPrice || 0)])
    );
    const sellNotionalBySymbol = new Map<string, number>();
    for (const order of effectiveOrders) {
      if (order.side !== 'SELL') continue;
      sellNotionalBySymbol.set(order.symbol, (sellNotionalBySymbol.get(order.symbol) || 0) + (order.notionalUSD || 0));
    }

    effectiveOrders = effectiveOrders
      .map((order) => {
        if (order.side !== 'BUY') return order;
        const heldNotional = heldNotionalBySymbol.get(order.symbol) || 0;
        const plannedSellNotional = sellNotionalBySymbol.get(order.symbol) || 0;
        const notionalBeforeBuy = Math.max(0, heldNotional - plannedSellNotional);
        const remainingRoom = Math.max(0, maxPositionNotional - notionalBeforeBuy);
        if ((order.notionalUSD || 0) <= remainingRoom + 1e-9) return order;
        if (remainingRoom <= 0) {
          adjustments.push({
            rule: 'POSITION_SIZE',
            symbol: order.symbol,
            beforeNotionalUSD: order.notionalUSD || 0,
            afterNotionalUSD: 0
          });
          return null;
        }
        adjustments.push({
          rule: 'POSITION_SIZE',
          symbol: order.symbol,
          beforeNotionalUSD: order.notionalUSD || 0,
          afterNotionalUSD: remainingRoom
        });
        return {
          ...order,
          notionalUSD: remainingRoom
        };
      })
      .filter((order): order is NonNullable<typeof order> => order !== null && (order.notionalUSD || 0) > 1e-9);
  }

  const sizeViolations = violatesPositionSize(effectiveOrders, portfolio.equity, config.maxPositionPct);
  if (sizeViolations.length) {
    blockedReasons.push(`Position size too large: ${sizeViolations.map((o) => o.symbol).join(', ')}`);
  }

  if (insufficientCash(effectiveOrders, portfolio, config.minCashPct)) {
    blockedReasons.push('Insufficient cash after respecting minCashPct buffer');
  }

  const shorts = hasShorting(effectiveOrders, portfolio.holdings);
  if (shorts.length) {
    blockedReasons.push(`Shorting not allowed (SELL without holdings): ${shorts.map((o) => o.symbol).join(', ')}`);
  }

  if (violatesTurnoverCap(effectiveOrders, portfolio.equity, config.maxNotionalTradedPctPerRun)) {
    const total = totalAbsoluteNotional(effectiveOrders).toFixed(2);
    const limit = (portfolio.equity * config.maxNotionalTradedPctPerRun).toFixed(2);
    blockedReasons.push(`Turnover too high: ${total} > ${limit}`);
  }

  const minHoldViolations = violatesMinHold(effectiveOrders, portfolio.holdings, intent.asOf, config.minHoldHours);
  if (minHoldViolations.length) {
    blockedReasons.push(`Min hold not met: ${minHoldViolations.map((o) => o.symbol).join(', ')}`);
  }

  const approved = blockedReasons.length === 0;
  const buyNotional = totalBuyNotional(effectiveOrders);
  const sellNotional = totalSellNotional(effectiveOrders);
  const exposureSummary = {
    currentCash: portfolio.cash,
    totalNotional: buyNotional,
    projectedCash: portfolio.cash - buyNotional + sellNotional,
    drawdown: context.drawdown
  };

  const riskReport: RiskReport = {
    asOf: intent.asOf,
    approved,
    blockedReasons,
    approvedOrders: approved ? effectiveOrders : [],
    exposureSummary
  };
  if (adjustments.length) {
    riskReport.adjustments = adjustments;
  }

  return riskReport;
};
