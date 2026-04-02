import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';

const exposureGroups = {
  US_TOTAL_EQUITY: { members: ['VTI'] },
  INTL_TOTAL_EQUITY: { members: ['VXUS'] },
  US_MIN_VOL_EQUITY: { members: ['USMV'] },
  FI_INTERMEDIATE_TREASURY: { members: ['IEF'] }
};

describe('wholeSharePlanner subset optimization', () => {
  it('preserves more of the intended basket in a constrained small-budget case', () => {
    const params = {
      targets: [
        { symbol: 'VTI', weight: 0.5 },
        { symbol: 'VXUS', weight: 0.3 },
        { symbol: 'USMV', weight: 0.2 }
      ],
      prices: {
        VTI: 200,
        VXUS: 55,
        USMV: 60
      },
      buyBudgetUSD: 130,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.5 as const
    };

    const baseline = planWholeShareExecution({ ...params, mode: 'baseline', allowRemainder: true });
    const optimizedA = planWholeShareExecution({ ...params, mode: 'subset_optimized', allowRemainder: true });
    const optimizedB = planWholeShareExecution({ ...params, mode: 'subset_optimized', allowRemainder: true });

    expect(baseline.status).toBe('UNEXECUTABLE');
    expect(optimizedA.status).not.toBe('UNEXECUTABLE');
    expect(optimizedA.orders.filter((order) => order.quantity > 0).map((order) => order.symbol).sort()).toEqual(['USMV', 'VXUS']);
    expect(optimizedA.orders.reduce((sum, order) => sum + order.estNotionalUSD, 0)).toBeLessThanOrEqual(params.buyBudgetUSD + 1e-6);
    expect(optimizedA.leftoverCashUSD).toBeGreaterThanOrEqual(0);
    expect(optimizedA).toEqual(optimizedB);
  });

  it('still rejects impossible baskets when no symbol is affordable', () => {
    const plan = planWholeShareExecution({
      targets: [
        { symbol: 'VTI', weight: 0.6 },
        { symbol: 'USMV', weight: 0.4 }
      ],
      prices: {
        VTI: 200,
        USMV: 150
      },
      buyBudgetUSD: 100,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.5,
      mode: 'subset_optimized',
      allowRemainder: true
    });

    expect(plan.status).toBe('UNEXECUTABLE');
    expect(plan.orders).toEqual([]);
    expect(plan.leftoverCashUSD).toBe(100);
  });

  it('prefers a more deployed equity-preserving subset when fit is near-tied', () => {
    const params = {
      targets: [
        { symbol: 'VTI', weight: 0.42 },
        { symbol: 'USMV', weight: 0.21 },
        { symbol: 'VXUS', weight: 0.19 },
        { symbol: 'IEF', weight: 0.18 }
      ],
      prices: {
        VTI: 105,
        USMV: 54,
        VXUS: 52,
        IEF: 95
      },
      exposureGroups,
      buyBudgetUSD: 108,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.8 as const,
      allowRemainder: true
    };

    const baseline = planWholeShareExecution({ ...params, mode: 'subset_optimized' });
    const refinedA = planWholeShareExecution({ ...params, mode: 'subset_optimized_refined' });
    const refinedB = planWholeShareExecution({ ...params, mode: 'subset_optimized_refined' });

    expect(baseline.orders.filter((order) => order.quantity > 0).map((order) => order.symbol)).toEqual(['VTI']);
    expect(refinedA.orders.filter((order) => order.quantity > 0).map((order) => order.symbol).sort()).toEqual(['USMV', 'VXUS']);
    expect(refinedA.orders.reduce((sum, order) => sum + order.estNotionalUSD, 0)).toBeLessThanOrEqual(params.buyBudgetUSD + 1e-6);
    expect(refinedA.leftoverCashUSD).toBeLessThan(baseline.leftoverCashUSD);
    expect(refinedA.selectedSymbols).toHaveLength(2);
    expect(refinedA.skipped.filter((item) => item.reason === 'DROPPED_FOR_AFFORDABILITY_OPTIMIZED_SUBSET').map((item) => item.symbol)).toEqual(
      ['VTI', 'IEF']
    );
    expect(refinedA).toEqual(refinedB);
  });

  it('prefers a broader affordable basket over a near-tied singleton in composition mode', () => {
    const params = {
      targets: [
        { symbol: 'VTI', weight: 0.448 },
        { symbol: 'USMV', weight: 0.259 },
        { symbol: 'VXUS', weight: 0.19 },
        { symbol: 'IEF', weight: 0.103 }
      ],
      prices: {
        VTI: 119,
        USMV: 64,
        VXUS: 42,
        IEF: 81
      },
      exposureGroups,
      buyBudgetUSD: 127,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.85 as const,
      allowRemainder: true
    };

    const refined = planWholeShareExecution({ ...params, mode: 'subset_optimized_refined' });
    const compositionA = planWholeShareExecution({ ...params, mode: 'subset_optimized_composition' });
    const compositionB = planWholeShareExecution({ ...params, mode: 'subset_optimized_composition' });

    expect(refined.orders.filter((order) => order.quantity > 0).map((order) => order.symbol)).toEqual(['VTI']);
    expect(compositionA.orders.filter((order) => order.quantity > 0).map((order) => order.symbol).sort()).toEqual(['USMV', 'VXUS']);
    expect(compositionA.orders.reduce((sum, order) => sum + order.estNotionalUSD, 0)).toBeLessThanOrEqual(params.buyBudgetUSD + 1e-6);
    expect(compositionA.leftoverCashUSD).toBeGreaterThanOrEqual(0);
    expect(compositionA.selectedSymbols).toHaveLength(2);
    expect(compositionA).toEqual(compositionB);
  });
});
