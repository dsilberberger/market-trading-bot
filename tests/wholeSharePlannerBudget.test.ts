import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';

describe('wholeSharePlanner respects deploy budget and retains diversification', () => {
  it('keeps buys within budget and funds multiple targets', () => {
    const targets = [
      { symbol: 'VTI', notionalUSD: 525 },
      { symbol: 'VXUS', notionalUSD: 525 },
      { symbol: 'USMV', notionalUSD: 450 }
    ];
    const prices = { VTI: 336.31, VXUS: 76.54, USMV: 93.65 };
    const buyBudgetUSD = 525;

    const plan = planWholeShareExecution({
      targets,
      prices,
      buyBudgetUSD,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2
    });

    const totalNotional = plan.orders.reduce((acc, o) => acc + (o.estNotionalUSD || 0), 0);

    expect(totalNotional).toBeLessThanOrEqual(buyBudgetUSD + 1e-6);
    expect(plan.leftoverCashUSD).toBeGreaterThanOrEqual(0);
    // With all symbols tradeable, we should retain more than one position.
    expect(plan.orders.filter((o) => (o.quantity || 0) > 0).length).toBeGreaterThan(1);
  });
});

