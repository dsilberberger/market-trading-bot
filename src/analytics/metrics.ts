import { EquityPoint } from '../core/types';
import { average } from '../core/utils';

export interface SummaryMetrics {
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  weeklyVolatility: number;
  turnover: number;
}

export const computeWeeklyReturns = (points: EquityPoint[]): number[] => {
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const r = prev.equity > 0 ? (curr.equity - prev.equity) / prev.equity : 0;
    returns.push(r);
  }
  return returns;
};

export const computeSummaryMetrics = (points: EquityPoint[], startingCapital: number): SummaryMetrics => {
  if (!points.length) {
    return { totalReturn: 0, cagr: 0, maxDrawdown: 0, weeklyVolatility: 0, turnover: 0 };
  }
  const finalEquity = points[points.length - 1].equity;
  const totalReturn = startingCapital > 0 ? (finalEquity - startingCapital) / startingCapital : 0;
  const weeks = Math.max(points.length, 1);
  const cagr = weeks > 1 ? Math.pow(finalEquity / startingCapital, 52 / (weeks - 1)) - 1 : totalReturn;
  const maxDrawdown = Math.max(...points.map((p) => p.drawdown));
  const weeklyReturns = computeWeeklyReturns(points);
  const vol = weeklyReturns.length
    ? Math.sqrt(average(weeklyReturns.map((r) => (r - average(weeklyReturns)) ** 2)))
    : 0;
  const turnover = average(points.map((p) => Math.abs(p.exposure)));

  return {
    totalReturn,
    cagr,
    maxDrawdown,
    weeklyVolatility: vol,
    turnover
  };
};
