import { runSimulation } from '../scripts/simPortfolio';

const approxEqual = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;
const sumWeights = (rec: Record<string, number> = {}) =>
  Object.values(rec).reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
const maxAbsDelta = (a: Record<string, number> = {}, b: Record<string, number> = {}) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let max = 0;
  keys.forEach((k) => {
    const d = Math.abs((a[k] || 0) - (b[k] || 0));
    if (d > max) max = d;
  });
  return max;
};
const diffKeys = (a: Record<string, number> = {}, b: Record<string, number> = {}) => {
  const aKeys = new Set(Object.keys(a));
  const bKeys = new Set(Object.keys(b));
  const added: string[] = [];
  const removed: string[] = [];
  bKeys.forEach((k) => {
    if (!aKeys.has(k)) added.push(k);
  });
  aKeys.forEach((k) => {
    if (!bKeys.has(k)) removed.push(k);
  });
  return { added, removed };
};
const optionEventTypes = new Set(['OPT_OPEN_DEBIT', 'OPT_CLOSE_CREDIT', 'OPT_EXPIRE']);

describe('simPortfolio harness invariants', () => {
  let defaultRun: any[];

  beforeAll(async () => {
    defaultRun = await runSimulation({});
  });

  it('keeps nav invariants and integer ETF orders', async () => {
    expect(defaultRun.length).toBeGreaterThan(0);
    defaultRun.forEach((w) => {
      expect(w.invariantOk).toBe(true);
      expect(w.invariantViolations.length).toBe(0);
      w.orders.forEach((o: any) => {
        if (o.side === 'BUY' || o.side === 'SELL') {
          expect(Number.isInteger(o.quantity)).toBe(true);
        }
      });
    });
  });

  it('applies a single cash infusion that boosts base budget and triggers base buys', () => {
    const infusionWeeks = defaultRun.filter((w) => (w.cashEvents || []).some((e: any) => e.type === 'CASH_INFUSION'));
    expect(infusionWeeks).toHaveLength(1);
    const infusionWeek = infusionWeeks[0];
    const prior = defaultRun[Math.max(0, infusionWeek.scenarioWeekIndex - 1)];
    expect(infusionWeek.budgets.coreBudget).toBeGreaterThan(prior.budgets.coreBudget);
    const baseBuys = infusionWeek.orders.filter((o: any) => o.side === 'BUY' && o.sleeve === 'base');
    expect(baseBuys.length).toBeGreaterThan(0);
    const baseSymbols = baseBuys.map((o: any) => o.symbol);
    expect(baseSymbols.length).toBeGreaterThan(0);
  });

  it('reallocates budgets on base regime rising edge even with flat equity', async () => {
    const flatScenario = {
      baseReturns: { SPY: 0.01, QQQ: 0.012, TLT: 0, SPYM: 0.01, QQQM: 0.012, IWM: 0.015 },
      events: [],
      name: 'FLAT_POLICY_TEST'
    };
    const res = await runSimulation({ scenario: flatScenario as any, scenarioName: flatScenario.name, weeks: 12 });
    const anyBaseOrder = res.some((w) => (w.orders || []).some((o: any) => o.sleeve === 'base' && o.side === 'BUY'));
    expect(anyBaseOrder).toBe(true);
  });

  it('updates reserve ledger when insurance opens and releases it on close/expiry', () => {
    const openWeek = defaultRun.find((w) => w.insurance.action === 'OPEN');
    expect(openWeek).toBeDefined();
    if (openWeek) {
      expect(openWeek.reserveUsedInsurance).toBeGreaterThan(0);
      expect(openWeek.reserveRemaining).toBeLessThan(openWeek.reserveBudget);
      const closedWeek = defaultRun.slice(openWeek.scenarioWeekIndex + 1).find((w) => w.reserveUsedInsurance === 0 && w.insurance.state === 'INACTIVE');
      expect(closedWeek).toBeDefined();
      if (closedWeek) {
        expect(closedWeek.reserveRemaining).toBeCloseTo(closedWeek.reserveBudget - (closedWeek.reserveUsedGrowth || 0), 5);
      }
    }
  });

  it('opens insurance only on the dislocation rising edge', () => {
    const openWeeks = defaultRun.filter((w) => w.insurance.action === 'OPEN');
    expect(openWeeks).toHaveLength(1);
    const openWeek = openWeeks[0];
    expect(openWeek.dislocation.dislocationRisingEdge).toBe(true);
    expect(openWeek.insurance.insuranceTriggerReason).toBe('first_dislocation_week_rising_edge');
    const otherOpens = defaultRun.filter((w) => w.scenarioWeekIndex !== openWeek.scenarioWeekIndex && w.insurance.action === 'OPEN');
    expect(otherOpens.length).toBe(0);
  });

  it('keeps base sells allowed while dislocation sleeve stays protected', () => {
    const protectedWeeks = defaultRun.filter((w) => w.dislocation.protectFromSells);
    protectedWeeks.forEach((w) => {
      const dislocSells = w.orders.filter((o: any) => o.side === 'SELL' && o.sleeve === 'dislocation');
      expect(dislocSells.length).toBe(0);
    });
  });

  it('opens growth convexity only in risk-on regime when insurance is inactive', async () => {
    const robustRun = await runSimulation({ scenarioName: 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000' } as any);
    const growthOpens = robustRun.filter((w) => w.growth.action === 'OPEN');
    expect(growthOpens.length).toBeGreaterThan(0);
    growthOpens.forEach((w) => {
      expect(w.baseRegime).toBe('RISK_ON');
      expect(w.dislocation.phase).toBe('INACTIVE');
      expect(w.insurance.state).toBe('INACTIVE');
    });
  });

  it('keeps core/reserve split at 70/30 and applies confidence-based base caps', () => {
    defaultRun.forEach((w) => {
      const total = w.budgets.coreBudget + w.budgets.reserveBudget;
      expect(w.budgets.coreBudget / total).toBeCloseTo(0.7, 3);
      expect(w.budgets.reserveBudget / total).toBeCloseTo(0.3, 3);
    });
    const lowConfWeek = defaultRun.find((w) => (w.baseRegimePolicy?.equityConfidence ?? 1) < 0.35);
    expect(lowConfWeek?.budgets.baseExposureCapPct).toBeCloseTo(0.35, 2);
    const highConfWeek = defaultRun.find((w) => (w.baseRegimePolicy?.equityConfidence ?? 0) >= 0.6);
    expect(highConfWeek?.budgets.baseExposureCapPct).toBeCloseTo(1, 3);
  });

  it('uses dislocation overlay to fill unused core budget without breaching caps', () => {
    const addWeek = defaultRun.find((w) => w.dislocation.phase === 'ADD');
    expect(addWeek).toBeDefined();
    if (addWeek) {
      expect(addWeek.overlayOrders.length).toBeGreaterThan(0);
      const invested = addWeek.holdingsMarketValue;
      expect(invested).toBeLessThanOrEqual(addWeek.budgets.coreBudget + 1);
    }
  });

  it('keeps options sleeves fully in reserve with invariant checks', () => {
    defaultRun.forEach((w) => {
      expect(w.reserveInvariantOk).toBe(true);
      expect(w.reserveUsedTotal).toBeLessThanOrEqual(w.reserveBudget + 1e-6);
      const total = w.budgets.coreBudget + w.budgets.reserveBudget;
      expect(w.reserveBudget / total).toBeCloseTo(0.3, 3);
    });
  });

  it('never has insurance and growth concurrently active', () => {
    defaultRun.forEach((w) => {
      const insActive = w.insurance.state === 'DEPLOYED';
      const growthActive = w.growth.state === 'DEPLOYED';
      expect(!(insActive && growthActive)).toBe(true);
    });
  });

  it('applies cash infusion as 70/30 to core/reserve budgets', () => {
    const infusionWeek = defaultRun.find((w) => (w.cashEvents || []).some((e: any) => e.type === 'CASH_INFUSION'));
    expect(infusionWeek).toBeDefined();
    if (infusionWeek) {
      const infusion = (infusionWeek.cashEvents || []).find((e: any) => e.type === 'CASH_INFUSION')?.amount || 0;
      const pre = infusionWeek.budgetsPreInfusion;
      expect(pre).toBeDefined();
      if (pre) {
        const coreDelta = infusionWeek.budgets.coreBudget - pre.coreBudget;
        const reserveDelta = infusionWeek.budgets.reserveBudget - pre.reserveBudget;
        expect(coreDelta).toBeCloseTo(infusion * 0.7, 3);
        expect(reserveDelta).toBeCloseTo(infusion * 0.3, 3);
        const navPost = infusionWeek.navPostInfusion;
        expect(infusionWeek.budgets.coreBudget).toBeCloseTo(navPost * 0.7, 4);
        expect(infusionWeek.budgets.reserveBudget).toBeCloseTo(navPost * 0.3, 4);
      }
    }
  });

  it('runs a full dislocation lifecycle add->hold->reintegrate and transfers quantities to base', async () => {
    const forcedDislocation = {
      baseReturns: { SPY: -0.05, QQQ: -0.06, TLT: 0, SPYM: -0.05, QQQM: -0.06 },
      events: Array.from({ length: 18 }, (_, i) => {
        if (i >= 15) return { weekIndex: i, forceDislocationTier: 0, forceTierEngaged: false };
        return { weekIndex: i, forceDislocationTier: 2, forceTierEngaged: true };
      })
    };
    const res = await runSimulation({ scenario: forcedDislocation as any, scenarioName: 'FORCED_DISLOCATION', weeks: 18 });
    const phases = res.map((w) => w.dislocation.phase);
    expect(phases).toContain('HOLD');
    expect(phases).toContain('REINTEGRATE');
    const addWeeks = res.filter((w) => w.dislocation.phase === 'ADD');
    expect(addWeeks.some((w) => (w.overlayOrders || []).length > 0)).toBe(true);
    const reinWeek = res.find((w) => w.dislocation.phase === 'REINTEGRATE');
    if (reinWeek) {
      const hasDislocQty = Object.values(reinWeek.sleeves || {}).some((s: any) => (s.dislocationQty || 0) > 0);
      expect(hasDislocQty).toBe(false);
    }
  });

  it('derives proxy targets dynamically and includes high-momentum symbols when capital allows', async () => {
    expect(defaultRun[0]?.targetsSource?.fn).toBe('computeDynamicTargetsFromRegimes');
    const riskOnWeek = defaultRun.find((w) => w.baseRegime === 'RISK_ON');
    expect(riskOnWeek?.proxyTargets && Object.keys(riskOnWeek.proxyTargets).length).toBeGreaterThan(0);

    const regimeSwapScenario = {
      baseReturns: { SPY: 0.015, QQQ: 0.018, TLT: 0, SPYM: 0.015, QQQM: 0.018, IWM: 0.02 },
      events: [
        { weekIndex: 0 },
        { weekIndex: 8, cashInfusionUSD: 500 }
      ],
      name: 'REGIME_SWAP_CASH'
    };
    const res = await runSimulation({ scenario: regimeSwapScenario as any, scenarioName: regimeSwapScenario.name, weeks: 16 });
    const riskOn = res.find((w) => w.baseRegime === 'RISK_ON');
    expect(riskOn?.proxyTargets?.IWM).toBeGreaterThan(0);
    const buys = riskOn?.orders.filter((o: any) => o.side === 'BUY' && o.sleeve === 'base') || [];
    expect(buys.some((o: any) => o.symbol === 'IWM') || (riskOn?.proxyTargets?.IWM ?? 0) > 0).toBe(true);
  });

  it('keeps options spend contained to reserve and updates reserveUsed on open/close', () => {
    const insOpen = defaultRun.find((w) => w.insurance.action === 'OPEN');
    expect(insOpen).toBeDefined();
    if (insOpen) {
      const pos = insOpen.insurance.position;
      const cost = (pos?.contracts || 0) * (pos?.premiumPerShare || 0) * 100;
      expect(insOpen.reserveUsedInsurance).toBeCloseTo(cost, 1);
      const debit = (insOpen.cashEvents || []).find((e: any) => e.type === 'OPT_OPEN_DEBIT' && e.sleeve === 'insurance');
      expect(debit?.amount || 0).toBeCloseTo(-cost, 1);
    }
    const insClosed = defaultRun.find((w) => w.insurance.action === 'CLOSE');
    if (insClosed) {
      expect(insClosed.reserveUsedInsurance).toBeCloseTo(0, 6);
      const credit = (insClosed.cashEvents || []).find((e: any) => e.type === 'OPT_CLOSE_CREDIT' && e.sleeve === 'insurance');
      expect(credit).toBeDefined();
    }
    defaultRun.forEach((w) => {
      expect(w.reserveUsedTotal).toBeLessThanOrEqual(w.reserveBudget + 1e-6);
    });
  });

  it('does not open growth while dislocation is active and does not open insurance off benign weeks', () => {
    defaultRun.forEach((w) => {
      if (w.dislocation.phase !== 'INACTIVE') {
        expect(w.growth.action).not.toBe('OPEN');
      }
      if (!w.dislocation.dislocationRisingEdge) {
        expect(w.insurance.action).not.toBe('OPEN');
      }
    });
  });

  it('enforces cash infusion allocation invariants at 70/30 split', () => {
    const infusionWeeks = defaultRun.filter((w) => (w.cashEvents || []).some((e: any) => e.type === 'CASH_INFUSION'));
    expect(infusionWeeks.length).toBeGreaterThan(0);
    infusionWeeks.forEach((w) => {
      const infusion = (w.cashEvents || [])
        .filter((e: any) => e.type === 'CASH_INFUSION')
        .reduce((acc: number, e: any) => acc + (e.amount || 0), 0);
      expect(approxEqual((w.navPostInfusion || 0) - (w.navPreInfusion || 0), infusion, 1e-2)).toBe(true);
      const pre = w.budgetsPreInfusion;
      expect(pre).toBeDefined();
      if (pre) {
        const coreDelta = w.budgets.coreBudget - pre.coreBudget;
        const reserveDelta = w.budgets.reserveBudget - pre.reserveBudget;
        expect(approxEqual(coreDelta, infusion * 0.7, 1e-2)).toBe(true);
        expect(approxEqual(reserveDelta, infusion * 0.3, 1e-2)).toBe(true);
      }
    });
  });

  it('keeps universal/proxy targets normalized and non-negative each week', () => {
    defaultRun.forEach((w, idx) => {
      const uniSum = sumWeights(w.universalTargets || {});
      const proxySum = sumWeights(w.proxyTargets || {});
      const diag = w.mappingDiagnostics || {};
      expect(approxEqual(uniSum, 1, 1e-4)).toBe(true);
      if (proxySum > 0) {
        expect(approxEqual(proxySum, 1, 1e-4)).toBe(true);
      } else {
        expect(proxySum).toBeGreaterThanOrEqual(0);
      }
      (Object.values(w.universalTargets || {}) as number[]).forEach((v) => {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      });
      (Object.values(w.proxyTargets || {}) as number[]).forEach((v) => {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      });
      const md = diag;
      if (md.universalSum !== undefined) expect(approxEqual(md.universalSum, 1, 1e-4)).toBe(true);
      if (md.proxySum !== undefined && md.proxySum > 0) expect(approxEqual(md.proxySum, 1, 1e-4)).toBe(true);
      if (md.executedSumNormalized !== undefined && md.executedSumNormalized > 0)
        expect(approxEqual(md.executedSumNormalized, 1, 1e-4)).toBe(true);
      if (md.ratioPreserved !== undefined && md.ratioPreserved !== false) {
        expect(md.ratioPreserved).toBe(true);
      }
    });
  });

  it('uses shared ETF headroom for dislocation after base sells', async () => {
    const scenario = {
      baseReturns: { SPY: -0.1, QQQ: -0.1, SPYM: -0.1, QQQM: -0.1 },
      events: [{ weekIndex: 0 }, { weekIndex: 1, forceDislocationTier: 2, forceTierEngaged: true }]
    };
    const res = await runSimulation({ scenario: scenario as any, scenarioName: 'DISLOCATION_RECOVERY', weeks: 4, startingCapitalUSD: 500 });
    const addWeek = res.find((w: any) => w.dislocation?.phase === 'ADD');
    expect(addWeek).toBeDefined();
    if (addWeek) {
      expect(addWeek.budgets.coreBudget).toBeCloseTo(addWeek.navPostInfusion * 0.7, 4);
      const overlayOrders = addWeek.overlayOrders || [];
      const baseSells = addWeek.cashEvents.filter((e: any) => e.type === 'ETF_SELL_CREDIT' && e.sleeve === 'base');
      const dislocBuys = overlayOrders.filter((o: any) => o.side === 'BUY');
      if (dislocBuys.length === 0 && baseSells.length === 0) {
        const perSym = addWeek.dislocationAllocationDiagnostics?.perSymbol || {};
        const hasSkip = Object.values(perSym).some((p: any) => p.skipReason);
        expect(hasSkip).toBe(true);
      } else {
        expect(baseSells.length + dislocBuys.length).toBeGreaterThan(0);
      }
      const mv = addWeek.holdingsMarketValue;
      expect(mv).toBeLessThanOrEqual(addWeek.budgets.coreBudget + 1e-3);
    }
  });

  it('shifts targets when baseRegime rising edge occurs', () => {
    const risingWeeks = defaultRun.filter((w) => w.baseRegimeRisingEdge);
    expect(risingWeeks.length).toBeGreaterThan(0);
    risingWeeks.forEach((w) => {
      const prev = defaultRun.find((p) => p.scenarioWeekIndex === w.scenarioWeekIndex - 1);
      expect(prev).toBeDefined();
      if (!prev) return;
      const deltas = maxAbsDelta(prev.proxyTargets || {}, w.proxyTargets || {});
      const keyDiff = diffKeys(prev.proxyTargets || {}, w.proxyTargets || {});
      const shifted = keyDiff.added.length > 0 || keyDiff.removed.length > 0 || deltas >= 0.05;
      if (!shifted) {
        throw new Error(
          `Targets did not shift on regime change at week ${w.scenarioWeekIndex} (${w.asOf}): prev=${JSON.stringify(
            prev.proxyTargets
          )} curr=${JSON.stringify(w.proxyTargets)} regimes=${prev.baseRegime}->${w.baseRegime}`
        );
      }
    });
  });

  it('logs dislocation allocation diagnostics and buys only target symbols during ADD', () => {
    const addWeeks = defaultRun.filter(
      (w) =>
        w.dislocation &&
        w.dislocation.tierEngaged &&
        w.dislocation.phase === 'ADD' &&
        (w.overlayOrders || []).some((o: any) => o.side === 'BUY')
    );
    const allowedOverlaySymbols = new Set(['SPYM', 'QQQM', 'SPY', 'QQQ']);
    addWeeks.forEach((w) => {
      expect(w.dislocationAllocationDiagnostics).toBeDefined();
      const diag = w.dislocationAllocationDiagnostics || {};
      (w.overlayOrders || [])
        .filter((o: any) => o.side === 'BUY')
        .forEach((o: any) => {
          const per = (diag.perSymbol as any) || {};
          const match = (Object.values(per) as any[]).find((p: any) => p.executedSymbol === o.symbol) as any;
          const weight = match?.targetWeight || 0;
          expect(weight > 0 || allowedOverlaySymbols.has(o.symbol)).toBe(true);
          expect(allowedOverlaySymbols.has(o.symbol)).toBe(true);
        });
      Object.entries((diag.perSymbol as any) || {}).forEach(([sym, info]: any) => {
        if (info.targetWeight > 0 && info.executedQty === 0 && (diag.budgetUSD || 0) > 0) {
          expect(info.skipReason || info.affordable === false).toBeTruthy();
        }
      });
    });
  });

  it('maps universals directly when affordable and records executionMapping', () => {
    const anyDirect = defaultRun.some((w) =>
      (w.executionMapping || []).some((m: any) => m.reason === 'direct' && m.universalSymbol === m.executedSymbol)
    );
    expect(anyDirect).toBe(true);
  });

  it('falls back to proxies when universals are unaffordable and marks unmapped when neither is affordable', async () => {
    const skewedScenario = {
      baseReturns: { SPY: 0.2, SPYM: 0.2, QQQ: -0.2, QQQM: -0.2, TLT: -0.15, IWM: -0.15, EFA: -0.15, EEM: -0.15, SHY: -0.05, GLD: -0.05 },
      events: [{ weekIndex: 0 }],
      name: 'MOMENTUM_SPY_ONLY'
    };
    const proxyRun = await runSimulation({
      scenario: skewedScenario as any,
      scenarioName: skewedScenario.name,
      weeks: 6,
      startingCapitalUSD: 300
    });
    const proxyWeek = proxyRun.find((w: any) =>
      (w.executionMapping || []).some((m: any) => m.universalSymbol === 'SPY' && m.reason === 'proxy' && m.executedSymbol === 'SPYM')
    );
    expect(proxyWeek).toBeDefined();
    if (proxyWeek) {
      expect(proxyWeek.mappingDiagnostics.executedSumNormalized).toBeCloseTo(1, 4);
    }

    const unmappedRun = await runSimulation({
      scenario: skewedScenario as any,
      scenarioName: 'MOMENTUM_SPY_ONLY_UNAFFORDABLE',
      weeks: 6,
      startingCapitalUSD: 40
    });
    const unmappedWeek = unmappedRun.find((w: any) =>
      (w.executionMapping || []).some((m: any) => m.universalSymbol === 'SPY' && m.reason === 'too_expensive')
    );
    expect(unmappedWeek).toBeDefined();
    if (unmappedWeek) {
      expect(unmappedWeek.mappingDiagnostics.unmappedUniversals).toContain('SPY');
      expect(unmappedWeek.proxyTargets && sumWeights(unmappedWeek.proxyTargets)).toBe(0);
    }
  });

  it('options sleeves operate independently of ETF affordability/whole-share constraints', async () => {
    const expensiveScenario = {
      baseReturns: { SPY: 5.0, QQQ: 5.0, SPYM: 5.0, QQQM: 5.0 },
      events: [{ weekIndex: 0 }, { weekIndex: 1, cashInfusionUSD: 1000 }],
      name: 'EXPENSIVE_ETFS'
    };
    // Small starting capital makes ETFs unaffordable while reserve still sized on NAV for options
    const res = await runSimulation({ scenario: expensiveScenario as any, scenarioName: expensiveScenario.name, weeks: 6, startingCapitalUSD: 200 } as any);
    const anyEtfSkip = res.some((w: any) =>
      (w.orders || []).some((o: any) => o.side === 'SKIP' && (o.reason === 'cash' || o.reason === 'cashBuffer'))
    );
    expect(anyEtfSkip || res.some((w: any) => (w.proxyTargets && Object.keys(w.proxyTargets || {}).length === 0))).toBe(true);
    const optOpens = res.filter((w: any) => w.insurance?.action === 'OPEN' || w.growth?.action === 'OPEN');
    expect(optOpens.length).toBeGreaterThan(0);
    optOpens.forEach((w: any) => {
      const sleeve = w.insurance?.action === 'OPEN' ? 'insurance' : 'growth';
      const reserveUsed = sleeve === 'insurance' ? w.reserveUsedInsurance : w.reserveUsedGrowth;
      expect(reserveUsed).toBeGreaterThan(0);
      const optEvents = (w.cashEvents || []).filter((e: any) => e.sleeve === sleeve && e.type === 'OPT_OPEN_DEBIT');
      expect(optEvents.length).toBeGreaterThan(0);
      (optEvents || []).forEach((e: any) => {
        expect(['OPT_OPEN_DEBIT', 'OPT_CLOSE_CREDIT', 'OPT_EXPIRE']).toContain(e.type);
      });
      const optSkipReasons = [w.insurance?.skipReason, w.growth?.skipReason].filter(Boolean);
      optSkipReasons.forEach((r: any) => {
        expect(['cash', 'cashBuffer', 'coreCapReached', 'reserveProtected', 'too_expensive', 'minTrade']).not.toContain(r);
      });
    });
  });

  it('does not accumulate both universal and proxy holdings for the same exposure', async () => {
    const week1 = defaultRun[0];
    expect(week1.executionMapping).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ universalSymbol: 'SPY', executedSymbol: 'SPY', reason: 'direct' })
      ])
    );
    const week1Orders = (week1.orders || []).filter((o: any) => o.side === 'BUY' && o.sleeve === 'base');
    expect(week1Orders.some((o: any) => o.symbol === 'SPY')).toBe(true);
    expect(week1Orders.some((o: any) => o.symbol === 'SPYM')).toBe(false);
    // ensure no churn (BUY+SELL same symbol/sleeve in same week)
    defaultRun.forEach((w) => {
      const byKey: Record<string, { buy: number; sell: number }> = {};
      (w.orders || []).forEach((o: any) => {
        const key = `${o.sleeve}:${o.symbol}`;
        const entry = byKey[key] || { buy: 0, sell: 0 };
        if (o.side === 'BUY') entry.buy += o.quantity;
        else if (o.side === 'SELL') entry.sell += o.quantity;
        byKey[key] = entry;
      });
      Object.values(byKey).forEach((e) => {
        expect(!(e.buy > 0 && e.sell > 0)).toBe(true);
      });
    });
  });

  it('does not skip base/dislocation buys due to reserve protection (only cash or explicit buffer)', async () => {
    defaultRun.forEach((w) => {
      (w.orders || [])
        .filter((o: any) => o.side === 'SKIP' && (o.sleeve === 'base' || o.sleeve === 'dislocation'))
        .forEach((o: any) => {
          expect(['cash', 'cashBuffer']).toContain(o.reason);
          expect(o.reason).not.toBe('reserveProtected');
        });
    });
    const lowCap = await runSimulation({ startingCapitalUSD: 120, weeks: 3, scenarioName: 'DISLOCATION_RECOVERY' } as any);
    lowCap.forEach((w: any) => {
      (w.orders || [])
        .filter((o: any) => o.side === 'SKIP' && (o.sleeve === 'base' || o.sleeve === 'dislocation'))
        .forEach((o: any) => {
          expect(o.reason).not.toBe('reserveProtected');
        });
    });
  });

  it('tracks reserve accounting invariants for options sleeves', () => {
    defaultRun.forEach((w) => {
      expect(w.reserveUsedTotal).toBeCloseTo((w.reserveUsedInsurance || 0) + (w.reserveUsedGrowth || 0), 5);
      expect(w.reserveRemaining).toBeCloseTo((w.reserveBudget || 0) - (w.reserveUsedTotal || 0), 5);
      expect(w.reserveUsedInsurance).toBeGreaterThanOrEqual(0);
      expect(w.reserveUsedGrowth).toBeGreaterThanOrEqual(0);
      expect(w.reserveRemaining).toBeGreaterThanOrEqual(-1e-4);
    });
  });

  it('ensures option lifecycle invariants: OPEN/HOLD/CLOSE shapes and weeksToExpiry decay', async () => {
    const runs = [defaultRun, await runSimulation({ scenarioName: 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000' } as any)];
    runs.forEach((run) => {
      const bySleeve = ['insurance', 'growth'] as const;
      bySleeve.forEach((sleeve) => {
        const openWeek = run.find((w: any) => w[sleeve]?.action === 'OPEN');
        expect(openWeek).toBeDefined();
        if (openWeek) {
          const pos = openWeek[sleeve].position;
          expect(pos).toBeDefined();
          ['openedWeek', 'openWeekISO', 'type', 'strike', 'expiryWeek', 'contracts', 'premiumPerShare', 'underlying'].forEach((key) => {
            expect(pos[key]).toBeDefined();
          });
        }
        // Hold decay check
        for (let i = 1; i < run.length; i++) {
          const prev = run[i - 1];
          const curr = run[i];
          const prevPos = prev[sleeve]?.position;
          const currPos = curr[sleeve]?.position;
          if (prevPos && currPos) {
            const prevW = prev[sleeve]?.weeksToExpiry ?? 0;
            const currW = curr[sleeve]?.weeksToExpiry ?? 0;
            // allow small float jitter
            expect(prevW - currW).toBeCloseTo(1, 1);
          }
        }
        const closeWeek = run.find((w: any) => w[sleeve]?.action === 'CLOSE');
        if (closeWeek) {
          expect(closeWeek[sleeve].position === null || closeWeek[sleeve].position === undefined).toBe(true);
          expect(closeWeek[sleeve].mark).toBeCloseTo(0, 3);
          const optEvents = (closeWeek.cashEvents || []).filter((e: any) => optionEventTypes.has(e.type) && e.sleeve === sleeve);
          expect(optEvents.length).toBeGreaterThan(0);
        }
      });
    });
  });

  it('keeps reserve budget at 30% of equity and updates reserve ledger on option open/close with mark tracking', async () => {
    const runs = [defaultRun, await runSimulation({ scenarioName: 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000' } as any)];
    runs.forEach((run) => {
      run.forEach((w: any) => {
        const total = (w.budgets?.coreBudget || 0) + (w.budgets?.reserveBudget || 0);
        if (total > 0) expect(w.budgets.reserveBudget / total).toBeCloseTo(0.3, 3);
        expect(w.reserveRemaining).toBeCloseTo((w.reserveBudget || 0) - (w.reserveUsedTotal || 0), 4);
        expect(w.reserveUsedTotal).toBeCloseTo((w.reserveUsedInsurance || 0) + (w.reserveUsedGrowth || 0), 4);
      });
      const insOpen = run.find((w: any) => w.insurance?.action === 'OPEN');
      if (insOpen) {
        expect(insOpen.reserveUsedInsurance).toBeGreaterThan(0);
        expect(insOpen.reserveRemaining).toBeLessThan(insOpen.reserveBudget);
        expect((insOpen.cashEvents || []).some((e: any) => e.type === 'OPT_OPEN_DEBIT' && e.sleeve === 'insurance')).toBe(true);
        expect(insOpen.optionsMarketValue).toBeGreaterThan(0);
      }
      const insClosed = run.find((w: any) => w.insurance?.action === 'CLOSE' || w.insurance?.action === 'SKIP' && !w.insurance?.position && (w.reserveUsedInsurance || 0) === 0);
      if (insClosed) {
        expect(insClosed.reserveUsedInsurance).toBeCloseTo(0, 4);
        const credit = (insClosed.cashEvents || []).some((e: any) => e.type === 'OPT_CLOSE_CREDIT' && e.sleeve === 'insurance');
        expect(credit || insClosed.insurance?.action === 'SKIP').toBe(true);
      }

      const growthOpen = run.find((w: any) => w.growth?.action === 'OPEN');
      if (growthOpen) {
        expect(growthOpen.reserveUsedGrowth).toBeGreaterThan(0);
        expect(growthOpen.optionsMarketValue).toBeGreaterThan(0);
        expect((growthOpen.cashEvents || []).some((e: any) => e.type === 'OPT_OPEN_DEBIT' && e.sleeve === 'growth')).toBe(true);
      }
      const growthClosed = run.find((w: any) => w.growth?.action === 'CLOSE' || w.growth?.action === 'SKIP' && !w.growth?.position && (w.reserveUsedGrowth || 0) === 0);
      if (growthClosed) {
        expect(growthClosed.reserveUsedGrowth).toBeCloseTo(0, 4);
        const credit = (growthClosed.cashEvents || []).some((e: any) => e.type === 'OPT_CLOSE_CREDIT' && e.sleeve === 'growth');
        expect(credit || growthClosed.growth?.action === 'SKIP').toBe(true);
      }
    });
  });

  it('keeps option cash reconciliation consistent with cashEvents and marks', () => {
    defaultRun.forEach((w) => {
      expect(w.cashReconciliationOk).toBe(true);
      const optionDelta = (w.cashEvents || [])
        .filter((e: any) => optionEventTypes.has(e.type))
        .reduce((acc: number, e: any) => acc + (e.amount || 0), 0);
      const nonOptionDelta = (w.cashEvents || [])
        .filter((e: any) => !optionEventTypes.has(e.type))
        .reduce((acc: number, e: any) => acc + (e.amount || 0), 0);
      expect(optionDelta + nonOptionDelta).toBeCloseTo(w.cashDeltaFromEvents || 0, 5);
      if ((w.insurance?.action === 'OPEN' || w.growth?.action === 'OPEN') && (w.cashEvents || []).length) {
        expect(optionDelta).toBeLessThan(0);
      }
      if ((w.insurance?.action === 'CLOSE' || w.growth?.action === 'CLOSE') && (w.cashEvents || []).length) {
        expect(optionDelta).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('covers option lifecycle scenarios (insurance on dislocation rising edge, growth in risk-on)', async () => {
    const insOpen = defaultRun.find((w: any) => w.insurance?.action === 'OPEN');
    expect(insOpen).toBeDefined();
    const insHold = defaultRun.find((w: any) => w.insurance?.action === 'HOLD' || w.insurance?.position);
    expect(insHold).toBeDefined();
    const insClose = defaultRun.find((w: any) => w.insurance?.action === 'CLOSE');
    expect(insClose || insHold).toBeDefined();

    const growthRun = await runSimulation({ scenarioName: 'STRESS_NORMALIZE_ROBUST_WITH_INFUSION_1000' } as any);
    const growthOpen = growthRun.find((w: any) => w.growth?.action === 'OPEN');
    expect(growthOpen).toBeDefined();
    const growthHold = growthRun.find((w: any) => w.growth?.action === 'HOLD');
    expect(growthHold).toBeDefined();
    const growthClose = growthRun.find((w: any) => w.growth?.action === 'CLOSE');
    expect(growthClose || growthHold).toBeDefined();
  });
});
