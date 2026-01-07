import { planWholeShareExecution } from '../src/execution/wholeSharePlanner';

describe('wholeSharePlanner execution proxies', () => {
  it('falls back to proxy when canonical is unaffordable but proxy is affordable', () => {
    const targets = [
      { symbol: 'VTI', weight: 0.35 },
      { symbol: 'VXUS', weight: 0.35 },
      { symbol: 'USMV', weight: 0.3 }
    ];
    const prices = { VTI: 300, VXUS: 70, USMV: 90, SCHB: 50 };
    const proxyMap = { VTI: ['SCHB'] };
    const budget = 420; // cannot buy one share of each canonical (300+70+90=460), but proxy makes it feasible

    const plan = planWholeShareExecution({
      targets,
      prices,
      buyBudgetUSD: budget,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.25,
      proxyMap,
      allowProxies: true
    });

    const spend = plan.orders.reduce((acc, o) => acc + (o.estNotionalUSD || 0), 0);
    expect(spend).toBeLessThanOrEqual(budget + 1e-6);
    expect(plan.orders.some((o) => o.symbol === 'SCHB')).toBe(true);
    expect(plan.orders.some((o) => o.symbol === 'VTI')).toBe(false);
    expect(plan.substitutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalSymbol: 'VTI',
          executedSymbol: 'SCHB',
          reason: 'PROXY_SUBSTITUTION'
        })
      ])
    );
  });

  it('uses canonical when affordable even if proxy exists', () => {
    const targets = [
      { symbol: 'VTI', weight: 0.35 },
      { symbol: 'VXUS', weight: 0.35 },
      { symbol: 'USMV', weight: 0.3 }
    ];
    const prices = { VTI: 120, VXUS: 70, USMV: 90, SCHB: 50 };
    const proxyMap = { VTI: ['SCHB'] };
    const budget = 420; // can afford canonical

    const plan = planWholeShareExecution({
      targets,
      prices,
      buyBudgetUSD: budget,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.25,
      proxyMap,
      allowProxies: true
    });

    expect(plan.orders.some((o) => o.symbol === 'VTI')).toBe(true);
    expect(plan.orders.some((o) => o.symbol === 'SCHB')).toBe(false);
    expect(plan.substitutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalSymbol: 'VTI',
          executedSymbol: 'VTI',
          reason: 'ORIGINAL'
        })
      ])
    );
  });
});

