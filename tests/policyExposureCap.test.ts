import { derivePolicyExposureCap, mapPolicyExposureCap } from '../src/risk/policyExposureCap';

describe('mapPolicyExposureCap', () => {
  it('maps neutral low-vol low confidence to the smoothed floor', () => {
    expect(mapPolicyExposureCap(0.2, 'neutral', 'low')).toBe(0.35);
  });

  it('ramps neutral low-vol exposure smoothly through the transition band', () => {
    expect(mapPolicyExposureCap(0.5, 'neutral', 'low')).toBeCloseTo(0.35);
    expect(mapPolicyExposureCap(0.65, 'neutral', 'low')).toBeCloseTo(0.675);
  });

  it('reaches full neutral low-vol exposure at high confidence', () => {
    expect(mapPolicyExposureCap(0.8, 'neutral', 'low')).toBe(1);
  });

  it('ramps risk-on exposure smoothly through the transition band', () => {
    expect(mapPolicyExposureCap(0.5, 'risk_on', 'low')).toBeCloseTo(0.35);
    expect(mapPolicyExposureCap(0.65, 'risk_on', 'low')).toBeCloseTo(0.675);
    expect(mapPolicyExposureCap(0.8, 'risk_on', 'low')).toBe(1);
  });

  it('keeps non-neutral low-confidence cases at 0.35', () => {
    expect(mapPolicyExposureCap(0.2, 'risk_on', 'low')).toBe(0.35);
  });

  it('keeps risk-off stressed low-confidence cases unchanged', () => {
    expect(mapPolicyExposureCap(0.2, 'risk_off', 'stressed')).toBe(0.35);
  });

  it('keeps live and sim regime labels in parity', () => {
    expect(mapPolicyExposureCap(0.2, 'neutral', 'low')).toBe(mapPolicyExposureCap(0.2, 'NEUTRAL', 'low'));
    expect(mapPolicyExposureCap(0.5, 'risk_off', 'stressed')).toBe(mapPolicyExposureCap(0.5, 'RISK_OFF', 'stressed'));
  });
});

describe('derivePolicyExposureCap coarse-percentile experimental variant', () => {
  it('preserves baseline hard-cap behavior by default in coarse contexts', () => {
    expect(
      derivePolicyExposureCap({
        equityConfidence: 0.95,
        regimeLabel: 'risk_on',
        volLabel: 'low',
        hasCoarsePercentiles: true,
        transitionRisk: 'low'
      })
    ).toBe(0.7);
  });

  it('keeps the protective coarse cap in weaker experimental contexts', () => {
    expect(
      derivePolicyExposureCap({
        equityConfidence: 0.75,
        regimeLabel: 'risk_on',
        volLabel: 'low',
        hasCoarsePercentiles: true,
        transitionRisk: 'low',
        coarsePercentilesPolicy: {
          mode: 'conditioned_risk_on',
          weakContextCapPct: 0.7,
          strongRiskOnCapPct: 0.85,
          strongRiskOnMinConfidence: 0.8,
          strongRiskOnRequireLowVol: true,
          strongRiskOnRequireLowTransitionRisk: true
        }
      })
    ).toBe(0.7);

    expect(
      derivePolicyExposureCap({
        equityConfidence: 0.95,
        regimeLabel: 'neutral',
        volLabel: 'low',
        hasCoarsePercentiles: true,
        transitionRisk: 'low',
        coarsePercentilesPolicy: {
          mode: 'conditioned_risk_on',
          weakContextCapPct: 0.7,
          strongRiskOnCapPct: 0.85
        }
      })
    ).toBe(0.7);
  });

  it('allows strong risk-on contexts to exceed 0.7 under the experimental variant', () => {
    expect(
      derivePolicyExposureCap({
        equityConfidence: 0.95,
        regimeLabel: 'risk_on',
        volLabel: 'low',
        hasCoarsePercentiles: true,
        transitionRisk: 'low',
        coarsePercentilesPolicy: {
          mode: 'conditioned_risk_on',
          weakContextCapPct: 0.7,
          strongRiskOnCapPct: 0.85,
          strongRiskOnMinConfidence: 0.8,
          strongRiskOnRequireLowVol: true,
          strongRiskOnRequireLowTransitionRisk: true
        }
      })
    ).toBe(0.85);
  });

  it('keeps high-transition-risk favorable contexts bounded even under the experimental variant', () => {
    expect(
      derivePolicyExposureCap({
        equityConfidence: 0.95,
        regimeLabel: 'risk_on',
        volLabel: 'low',
        hasCoarsePercentiles: true,
        transitionRisk: 'high',
        coarsePercentilesPolicy: {
          mode: 'conditioned_risk_on',
          weakContextCapPct: 0.7,
          strongRiskOnCapPct: 0.85,
          strongRiskOnMinConfidence: 0.8,
          strongRiskOnRequireLowVol: true,
          strongRiskOnRequireLowTransitionRisk: true
        }
      })
    ).toBe(0.35);
  });
});
