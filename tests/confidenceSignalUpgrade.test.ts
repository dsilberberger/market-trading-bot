import { computeBaseEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { SymbolFeature } from '../src/core/types';

const makeFeature = (overrides: Partial<SymbolFeature> = {}): SymbolFeature =>
  ({
    symbol: 'SPY',
    price: 100,
    barInterval: '1w',
    return4w: 0,
    return12w: 0,
    return24w: 0,
    return60d: 0.01,
    return60dPctileBucket: 'mid',
    vol20dPctileBucket: 'mid',
    above200dma: false,
    agreementScore: 0,
    stabilityScore: 0,
    ...overrides
  }) as SymbolFeature;

describe('confidence signal upgrade', () => {
  it('increases confidence when horizons agree and stability is high', () => {
    const currentLike = makeFeature();
    const upgraded = makeFeature({
      return4w: 0.02,
      return12w: 0.03,
      return24w: 0.05,
      agreementScore: 1,
      stabilityScore: 1
    });

    expect(computeBaseEquityConfidence(upgraded)).toBeGreaterThan(computeBaseEquityConfidence(currentLike) || 0);
  });

  it('adds only a small increase when horizons conflict', () => {
    const base = computeBaseEquityConfidence(makeFeature({ return4w: 0.02, return12w: -0.03, return24w: 0.05 })) || 0;
    const conflicted = computeBaseEquityConfidence(
      makeFeature({
        return4w: 0.02,
        return12w: -0.03,
        return24w: 0.05,
        agreementScore: 2 / 3,
        stabilityScore: 0
      })
    ) || 0;

    expect(conflicted - base).toBeCloseTo(0.1, 5);
  });

  it('keeps the increase small when stability is low', () => {
    const lowStability = computeBaseEquityConfidence(
      makeFeature({
        return4w: -0.01,
        return12w: -0.02,
        return24w: -0.03,
        agreementScore: 1,
        stabilityScore: 0.1
      })
    ) || 0;
    const highStability = computeBaseEquityConfidence(
      makeFeature({
        return4w: -0.01,
        return12w: -0.02,
        return24w: -0.03,
        agreementScore: 1,
        stabilityScore: 1
      })
    ) || 0;

    expect(highStability - lowStability).toBeGreaterThan(0.1);
  });

  it('remains bounded within [0,1]', () => {
    const confidence = computeBaseEquityConfidence(
      makeFeature({
        return60d: 0.3,
        above200dma: true,
        return4w: 0.2,
        return12w: 0.4,
        return24w: 0.8,
        agreementScore: 1,
        stabilityScore: 1
      })
    );

    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it('matches prior behavior when agreement and stability are zero', () => {
    const confidence = computeBaseEquityConfidence(
      makeFeature({
        return60d: 0.02,
        above200dma: true,
        agreementScore: 0,
        stabilityScore: 0
      })
    );

    expect(confidence).toBeCloseTo(0.3, 10);
  });
});
