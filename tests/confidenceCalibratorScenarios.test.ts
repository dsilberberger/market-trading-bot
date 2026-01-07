import fs from 'fs';
import path from 'path';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { computeCoreDeployPct } from '../src/core/capital';
import { BotConfig, RegimeContext, SymbolFeature } from '../src/core/types';

// Diagnostic-only: compares how proxy directional features influence calibrated confidence.

const baseConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.json'), 'utf-8')) as BotConfig;

type Scenario = 'A_quality_only' | 'B_bullish_proxy' | 'C_bearish_proxy';

const baseRegime: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.2 } };
const prior = { label: 'risk_off', timeInRegimeWeeks: 3 };

const makeFeatures = (proxyVariant: Scenario): SymbolFeature[] => {
  const spyShort: SymbolFeature = {
    symbol: 'SPY',
    price: 100,
    barInterval: '1d',
    historySamples: 20,
    historyUniqueCloses: 20,
    return60d: 0.01,
    return60dPctileBucket: 'unknown',
    vol20dPctileBucket: 'unknown',
    above200dma: false
  } as any;

  const proxyBase: Partial<SymbolFeature> =
    proxyVariant === 'A_quality_only'
      ? { return60dPctileBucket: 'unknown', vol20dPctileBucket: 'unknown', above200dma: false }
      : proxyVariant === 'B_bullish_proxy'
      ? { return60dPctileBucket: 'high', vol20dPctileBucket: 'low', above200dma: true }
      : { return60dPctileBucket: 'low', vol20dPctileBucket: 'high', above200dma: false };

  const proxy: SymbolFeature = {
    symbol: 'SPYM',
    price: 100,
    barInterval: '1d',
    historySamples: 200,
    historyUniqueCloses: 200,
    return60d: proxyBase.return60dPctileBucket === 'high' ? 0.1 : proxyBase.return60dPctileBucket === 'low' ? -0.05 : 0.01,
    return60dPctileBucket: proxyBase.return60dPctileBucket as any,
    vol20dPctileBucket: proxyBase.vol20dPctileBucket as any,
    above200dma: proxyBase.above200dma
  } as any;

  return [spyShort, proxy];
};

const runScenario = (variant: Scenario) => {
  const features = makeFeatures(variant);
  const calibration = calibrateEquityConfidence({
    asOf: '2024-01-01',
    runId: 'diagnostic',
    regimes: baseRegime,
    features,
    config: baseConfig,
    proxiesMap: { SPY: ['SPYM'] },
    prior
  });
  const regimesAfter: RegimeContext = { equityRegime: { label: 'risk_off', confidence: calibration.confidence } };
  const deploy = computeCoreDeployPct(regimesAfter, baseConfig);
  return {
    variant,
    calibratedConfidence: Number(calibration.confidence.toFixed(4)),
    confidenceScale: deploy.confidenceScale,
    deployPct: Number(deploy.deployPct.toFixed(4))
  };
};

describe('confidence calibrator directional sensitivity (diagnostic)', () => {
  it('prints comparison across proxy feature variants', () => {
    const results = [runScenario('A_quality_only'), runScenario('B_bullish_proxy'), runScenario('C_bearish_proxy')];
    const header = ['Case', 'CalibratedConf', 'ConfidenceScale', 'DeployPct'].join(' | ');
    const rows = results.map(
      (r) => [r.variant, r.calibratedConfidence.toFixed(4), r.confidenceScale.toFixed(2), r.deployPct.toFixed(4)].join(' | ')
    );
    const table = [header, ...rows].join('\n');
    // Console output is the requested deliverable; no behavioral assertions beyond existence.
    // eslint-disable-next-line no-console
    console.log('\nConfidence calibration comparison:\n' + table + '\n');
    expect(results.length).toBe(3);
  });
});
