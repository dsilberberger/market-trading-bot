import { planBaseEtfExecution, planWholeShareExecution } from '../src/execution/wholeSharePlanner';

const sharesBySymbol = (plan: ReturnType<typeof planWholeShareExecution>) =>
  Object.fromEntries(plan.orders.map((o) => [o.symbol, o.quantity]));

describe('planBaseEtfExecution', () => {
  it('admits a mild neutral remainder fill when fit degradation stays bounded', () => {
    const params = {
      targets: [
        { symbol: 'VTI', notionalUSD: 839.87, priority: 0.8 },
        { symbol: 'VXUS', notionalUSD: 839.87, priority: 0.7 },
        { symbol: 'USMV', notionalUSD: 719.3, priority: 0.75 }
      ],
      prices: { VTI: 342.96, VXUS: 80.74, USMV: 95.17 },
      buyBudgetUSD: 1201.214,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2
    };

    const floorPlan = planWholeShareExecution({ ...params, allowRemainder: false });
    const remainderPlan = planWholeShareExecution({ ...params, allowRemainder: true });
    const selectedPlan = planBaseEtfExecution({ ...params, regimeLabel: 'neutral', timeInRegimeWeeks: 1 });

    expect(floorPlan.status).toBe('OK');
    expect(remainderPlan.status).toBe('OK');
    expect(remainderPlan.error.maxAbsError).toBeLessThanOrEqual(0.05);
    expect(remainderPlan.error.maxAbsError - floorPlan.error.maxAbsError).toBeLessThanOrEqual(0.01);
    expect(remainderPlan.error.l1Error - floorPlan.error.l1Error).toBeLessThanOrEqual(0.02);
    expect(sharesBySymbol(selectedPlan)).toEqual({ VTI: 1, USMV: 4, VXUS: 5 });
    expect(selectedPlan.orders).toEqual(remainderPlan.orders);
  });

  it('rejects an aggressive neutral remainder fill when fit degradation exceeds the guard', () => {
    const params = {
      targets: [
        { symbol: 'VTI', notionalUSD: 840, priority: 0.75 },
        { symbol: 'VXUS', notionalUSD: 840, priority: 0.7 },
        { symbol: 'USMV', notionalUSD: 721.49, priority: 0.65 }
      ],
      prices: { VTI: 315.47, VXUS: 74.95, USMV: 91.775 },
      buyBudgetUSD: 1178.46225,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2
    };

    const floorPlan = planWholeShareExecution({ ...params, allowRemainder: false });
    const remainderPlan = planWholeShareExecution({ ...params, allowRemainder: true });
    const selectedPlan = planBaseEtfExecution({ ...params, regimeLabel: 'neutral', timeInRegimeWeeks: 1 });

    expect(floorPlan.status).toBe('OK');
    expect(remainderPlan.status).toBe('OK');
    expect(remainderPlan.error.maxAbsError - floorPlan.error.maxAbsError).toBeGreaterThan(0.01);
    expect(remainderPlan.error.l1Error - floorPlan.error.l1Error).toBeGreaterThan(0.02);
    expect(sharesBySymbol(selectedPlan)).toEqual({ VTI: 1, VXUS: 5, USMV: 3 });
    expect(selectedPlan.orders).toEqual(floorPlan.orders);
  });

  it('keeps risk_off behavior on the floor-only path', () => {
    const params = {
      targets: [
        { symbol: 'VTI', notionalUSD: 839.87, priority: 0.8 },
        { symbol: 'VXUS', notionalUSD: 839.87, priority: 0.7 },
        { symbol: 'USMV', notionalUSD: 719.3, priority: 0.75 }
      ],
      prices: { VTI: 342.96, VXUS: 80.74, USMV: 95.17 },
      buyBudgetUSD: 1201.214,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2
    };

    const floorPlan = planWholeShareExecution({ ...params, allowRemainder: false });
    const selectedPlan = planBaseEtfExecution({ ...params, regimeLabel: 'risk_off', timeInRegimeWeeks: 4 });

    expect(sharesBySymbol(selectedPlan)).toEqual(sharesBySymbol(floorPlan));
    expect(selectedPlan.orders).toEqual(floorPlan.orders);
  });

  it('preserves existing risk_on remainder behavior', () => {
    const params = {
      targets: [
        { symbol: 'VTI', notionalUSD: 839.87, priority: 0.8 },
        { symbol: 'VXUS', notionalUSD: 839.87, priority: 0.7 },
        { symbol: 'USMV', notionalUSD: 719.3, priority: 0.75 }
      ],
      prices: { VTI: 342.96, VXUS: 80.74, USMV: 95.17 },
      buyBudgetUSD: 1201.214,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2
    };

    const remainderPlan = planWholeShareExecution({ ...params, allowRemainder: true });
    const selectedPlan = planBaseEtfExecution({ ...params, regimeLabel: 'risk_on', timeInRegimeWeeks: 1 });

    expect(sharesBySymbol(selectedPlan)).toEqual(sharesBySymbol(remainderPlan));
    expect(selectedPlan.orders).toEqual(remainderPlan.orders);
  });
});
