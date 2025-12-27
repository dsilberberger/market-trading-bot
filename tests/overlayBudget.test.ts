import { computeOverlayBudget } from '../src/dislocation/overlayBudget';
import { deriveLifecycleBooleans } from '../src/dislocation/sleeveLifecycle';

describe('overlay budget', () => {
  it('never exceeds available cash', () => {
    const res = computeOverlayBudget({
      equityUSD: 2000,
      cashUSD: 200,
      minCashUSD: 50,
      overlayExtraExposurePct: 0.3,
      maxTotalExposureCapPct: 0.7,
      currentInvestedUSD: 1800,
      cheapestOverlayPrice: 80
    });
    expect(res.overlayBudgetUSD).toBeGreaterThanOrEqual(0);
    expect(res.overlayBudgetUSD).toBeLessThanOrEqual(res.availableCashUSD);
  });

  it('blocks when below min lot', () => {
    const res = computeOverlayBudget({
      equityUSD: 2000,
      cashUSD: 30,
      minCashUSD: 0,
      overlayExtraExposurePct: 0.3,
      maxTotalExposureCapPct: 0.7,
      baseExposureCapPct: 0.35,
      currentInvestedUSD: 500,
      cheapestOverlayPrice: 50,
      overlayMinBudgetUSD: 200,
      overlayMinBudgetPolicy: 'gate',
      phase: 'ADD'
    });
    expect(res.overlayBudgetUSD).toBe(0);
    expect(res.flags.some((f) => f.code === 'OVERLAY_SKIPPED_MIN_BUDGET')).toBe(true);
  });
});

describe('lifecycle booleans', () => {
  it('derives consistent flags', () => {
    expect(deriveLifecycleBooleans('ADD')).toEqual({
      active: true,
      allowAdd: true,
      protectFromSells: true,
      allowReintegration: false
    });
    expect(deriveLifecycleBooleans('HOLD')).toEqual({
      active: true,
      allowAdd: false,
      protectFromSells: true,
      allowReintegration: false
    });
    expect(deriveLifecycleBooleans('REINTEGRATE')).toEqual({
      active: false,
      allowAdd: false,
      protectFromSells: false,
      allowReintegration: true
    });
    expect(deriveLifecycleBooleans(undefined)).toEqual({
      active: false,
      allowAdd: false,
      protectFromSells: false,
      allowReintegration: false
    });
  });
});
