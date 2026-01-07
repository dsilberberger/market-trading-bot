import { computeCoreDeployPct } from '../src/core/capital';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');

describe('confidence scaling is less punitive but still applied', () => {
  it('scales deployPct when confidence is below threshold', () => {
    const regimes = { equityRegime: { label: 'risk_on', confidence: 0.4 } };
    const { deployPct, confidenceScale } = computeCoreDeployPct(regimes, baseConfig as any);
    const baseCap = (baseConfig as any)?.capital?.baseDeployPct?.risk_on ?? 0.9;
    const scaleLow = (baseConfig as any)?.capital?.deployConfScaleLow ?? 0.95;

    // scaling applied
    expect(confidenceScale).toBe(scaleLow);
    expect(deployPct).toBeCloseTo(baseCap * scaleLow);
    expect(deployPct).toBeLessThan(baseCap); // still scaled down
  });

  it('does not scale above 1.0 when confidence is high', () => {
    const regimes = { equityRegime: { label: 'risk_on', confidence: 0.9 } };
    const { deployPct, confidenceScale } = computeCoreDeployPct(regimes, baseConfig as any);
    expect(confidenceScale).toBe(1);
    expect(deployPct).toBeLessThanOrEqual(1);
  });
});
