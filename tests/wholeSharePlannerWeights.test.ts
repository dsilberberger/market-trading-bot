import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';

describe('wholeSharePlanner weight fidelity', () => {
  it('keeps realized weights close to targets when affordable', () => {
    const targets = [
      { symbol: 'VTI', weight: 0.35 },
      { symbol: 'VXUS', weight: 0.35 },
      { symbol: 'USMV', weight: 0.3 }
    ];
    const prices = { VTI: 336.31, VXUS: 76.54, USMV: 93.65 };
    const buyBudgetUSD = 1000; // enough to afford at least one share of each

    const plan = planWholeShareExecution({
      targets,
      prices,
      buyBudgetUSD,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.25 // allow some whole-share drift
    });

    const total = plan.orders.reduce((acc, o) => acc + (o.estNotionalUSD || 0), 0);
    const realized: Record<string, number> = {};
    plan.orders.forEach((o) => {
      realized[o.symbol] = (o.estNotionalUSD || 0) / (total || 1);
    });

    expect(total).toBeLessThanOrEqual(buyBudgetUSD + 1e-6);
    // Expect at least two symbols funded when all are affordable.
    expect(Object.keys(realized).length).toBeGreaterThan(1);

    const tol = 0.05; // 5 percentage points
    expect(Math.abs((realized['VTI'] || 0) - 0.35)).toBeLessThanOrEqual(tol);
    expect(Math.abs((realized['VXUS'] || 0) - 0.35)).toBeLessThanOrEqual(tol);
    expect(Math.abs((realized['USMV'] || 0) - 0.3)).toBeLessThanOrEqual(tol);
  });
});
