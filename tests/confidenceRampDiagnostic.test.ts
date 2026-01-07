import fs from 'fs';
import path from 'path';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { computeCoreDeployPct } from '../src/core/capital';
import { BotConfig, RegimeContext, SymbolFeature } from '../src/core/types';

// Diagnostic-only: examine time-in-regime ramp vs confidence calibration. No production logic changes.

const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.json'), 'utf-8')) as BotConfig;

const baseRegime: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.2 } };

const features: SymbolFeature[] = [
  {
    symbol: 'SPY',
    price: 100,
    barInterval: '1d',
    historySamples: 20,
    historyUniqueCloses: 20,
    return60d: 0.01,
    return60dPctileBucket: 'unknown',
    vol20dPctileBucket: 'unknown',
    above200dma: false
  } as any,
  {
    symbol: 'SPYM',
    price: 100,
    barInterval: '1d',
    historySamples: 220,
    historyUniqueCloses: 220,
    return60d: 0.02,
    return60dPctileBucket: 'mid',
    vol20dPctileBucket: 'mid',
    above200dma: true
  } as any
];

type RampCase = { label: string; priorWeeks: number };

const cases: RampCase[] = [
  { label: 't=0', priorWeeks: 0 },
  { label: 't=2', priorWeeks: 2 },
  { label: 't=5', priorWeeks: 5 },
  { label: 't=10', priorWeeks: 10 }
];

const runCase = (c: RampCase) => {
  const calibration = calibrateEquityConfidence({
    asOf: '2024-01-01',
    runId: 'diagnostic-ramp',
    regimes: baseRegime,
    features,
    config: cfg,
    proxiesMap: { SPY: ['SPYM'] },
    prior: { label: 'risk_off', timeInRegimeWeeks: c.priorWeeks }
  });
  const regimesAfter: RegimeContext = { equityRegime: { label: 'risk_off', confidence: calibration.confidence } };
  const deploy = computeCoreDeployPct(regimesAfter, cfg);
  return {
    label: c.label,
    priorWeeks: c.priorWeeks,
    effectiveWeeks: calibration.diagnostics.timeInRegimeWeeks,
    calibratedConfidence: Number(calibration.confidence.toFixed(4)),
    confidenceScale: deploy.confidenceScale,
    deployPct: Number(deploy.deployPct.toFixed(4))
  };
};

describe('time-in-regime ramp diagnostic', () => {
  it('prints monotonic ramp impact and stays bounded', () => {
    const results = cases.map(runCase);
    const header = ['Case', 'priorWeeks', 'effectiveWeeks', 'calConf', 'confScale', 'deployPct'].join(' | ');
    const rows = results.map((r) =>
      [r.label, r.priorWeeks, r.effectiveWeeks, r.calibratedConfidence.toFixed(4), r.confidenceScale.toFixed(2), r.deployPct.toFixed(4)].join(' | ')
    );
    // eslint-disable-next-line no-console
    console.log('\nTime-in-regime ramp comparison:\n' + [header, ...rows].join('\n') + '\n');

    // Basic checks: non-decreasing confidence, bounded <=1
    for (let i = 1; i < results.length; i++) {
      expect(results[i].calibratedConfidence).toBeGreaterThanOrEqual(results[i - 1].calibratedConfidence - 1e-9);
    }
    results.forEach((r) => expect(r.calibratedConfidence).toBeLessThanOrEqual(1));
  });
});
