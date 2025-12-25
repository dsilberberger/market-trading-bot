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

  const violations = violatesUniverse(intent.orders, intent.universe);
  if (violations.length) {
    blockedReasons.push(`Orders outside universe: ${violations.map((v) => v.symbol).join(', ')}`);
  }

  if (violatesMaxTrades(intent.orders, config.maxTradesPerRun)) {
    blockedReasons.push(`Too many trades: ${intent.orders.length} > ${config.maxTradesPerRun}`);
  }

  const positionCount = countFuturePositions(intent.orders, portfolio);
  if (positionCount > config.maxPositions) {
    blockedReasons.push(`Max positions exceeded: ${positionCount} > ${config.maxPositions}`);
  }

  const sizeViolations = violatesPositionSize(intent.orders, portfolio.equity, config.maxPositionPct);
  if (sizeViolations.length) {
    blockedReasons.push(`Position size too large: ${sizeViolations.map((o) => o.symbol).join(', ')}`);
  }

  if (insufficientCash(intent.orders, portfolio, config.minCashPct)) {
    blockedReasons.push('Insufficient cash after respecting minCashPct buffer');
  }

  const shorts = hasShorting(intent.orders, portfolio.holdings);
  if (shorts.length) {
    blockedReasons.push(`Shorting not allowed (SELL without holdings): ${shorts.map((o) => o.symbol).join(', ')}`);
  }

  if (violatesTurnoverCap(intent.orders, portfolio.equity, config.maxNotionalTradedPctPerRun)) {
    const total = totalAbsoluteNotional(intent.orders).toFixed(2);
    const limit = (portfolio.equity * config.maxNotionalTradedPctPerRun).toFixed(2);
    blockedReasons.push(`Turnover too high: ${total} > ${limit}`);
  }

  const minHoldViolations = violatesMinHold(intent.orders, portfolio.holdings, intent.asOf, config.minHoldHours);
  if (minHoldViolations.length) {
    blockedReasons.push(`Min hold not met: ${minHoldViolations.map((o) => o.symbol).join(', ')}`);
  }

  if (context.drawdown >= config.maxWeeklyDrawdownPct) {
    const buys = intent.orders.filter((o) => o.side === 'BUY');
    if (buys.length) {
      blockedReasons.push('Drawdown limit hit; buys blocked this week');
    }
  }

  const approved = blockedReasons.length === 0;
  const buyNotional = totalBuyNotional(intent.orders);
  const sellNotional = totalSellNotional(intent.orders);
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
    approvedOrders: approved ? intent.orders : [],
    exposureSummary
  };

  return riskReport;
};
