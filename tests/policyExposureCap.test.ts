import { mapPolicyExposureCap } from '../src/risk/policyExposureCap';

describe('mapPolicyExposureCap', () => {
  it('maps neutral low-vol low confidence to 0.50', () => {
    expect(mapPolicyExposureCap(0.2, 'neutral', 'low')).toBe(0.5);
  });

  it('maps neutral low-vol mid confidence to 0.70', () => {
    expect(mapPolicyExposureCap(0.5, 'neutral', 'low')).toBe(0.7);
  });

  it('maps neutral low-vol high confidence to 1.00', () => {
    expect(mapPolicyExposureCap(0.6, 'neutral', 'low')).toBe(1);
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
