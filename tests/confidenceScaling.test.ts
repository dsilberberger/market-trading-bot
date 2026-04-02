import { computeCoreDeployPct } from '../src/core/capital';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const higherDeployConfig = require('../src/config/default.higher_risk_on_deploy.position_size_scaled_risk_gate.json');

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

  it('raises deployPct in strong risk_on states under the higher-deploy variant', () => {
    const regimes = { equityRegime: { label: 'risk_on', confidence: 0.9 } };
    const baseline = computeCoreDeployPct(regimes, baseConfig as any);
    const higherDeploy = computeCoreDeployPct(regimes, higherDeployConfig as any);

    expect(higherDeploy.deployPct).toBeGreaterThan(baseline.deployPct);
    expect(higherDeploy.deployPct).toBe(1);
    expect(baseline.deployPct).toBeLessThan(1);
  });

  it('leaves weak states unchanged under the higher-deploy variant', () => {
    const regimes = { equityRegime: { label: 'risk_off', confidence: 0.9 } };
    const baseline = computeCoreDeployPct(regimes, baseConfig as any);
    const higherDeploy = computeCoreDeployPct(regimes, higherDeployConfig as any);

    expect(higherDeploy.deployPct).toBeCloseTo(baseline.deployPct);
    expect(higherDeploy.confidenceScale).toBe(baseline.confidenceScale);
  });
});
