import fs from 'fs';
import path from 'path';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { BotConfig, RegimeContext, SymbolFeature } from '../src/core/types';

const baseConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.json'), 'utf-8')) as BotConfig;

describe('confidence calibrator', () => {
  const baseFeatures: SymbolFeature[] = [
    {
      symbol: 'SPY',
      price: 100,
      barInterval: '1d',
      historySamples: 20,
      historyUniqueCloses: 20,
      return60d: undefined,
      return60dPctileBucket: 'unknown',
      vol20dPctileBucket: 'unknown',
      above200dma: false
    } as any,
    {
      symbol: 'SPYM',
      price: 100,
      barInterval: '1d',
      historySamples: 200,
      historyUniqueCloses: 200,
      return60d: 0.05,
      return60dPctileBucket: 'high',
      vol20dPctileBucket: 'mid',
      above200dma: true
    } as any
  ];

  it('raises confidence when coverage is short but proxy history exists', () => {
    const regimes: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.2 } };
    const result = calibrateEquityConfidence({
      asOf: '2024-01-01',
      regimes,
      features: baseFeatures,
      config: { ...baseConfig, confidenceCalibration: { ...baseConfig.confidenceCalibration, minHistoryDays: 120 } },
      proxiesMap: { SPY: ['SPYM'] }
    });
    expect(result.confidence).toBeGreaterThan(regimes.equityRegime?.confidence || 0);
    expect(result.diagnostics.proxy?.symbol).toBe('SPYM');
  });

  it('applies time-in-regime ramp toward target confidence', () => {
    const regimes: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.3 } };
    const res = calibrateEquityConfidence({
      asOf: '2024-01-08',
      regimes,
      features: baseFeatures,
      config: {
        ...baseConfig,
        confidenceCalibration: { ...baseConfig.confidenceCalibration, minHistoryDays: 200, coverageFloorConfidence: 0.6 }
      },
      proxiesMap: { SPY: ['SPYM'] },
      prior: { label: 'risk_off', timeInRegimeWeeks: 3 }
    });
    expect(res.confidence).toBeGreaterThan(regimes.equityRegime?.confidence || 0);
    expect(res.diagnostics.timeInRegimeWeeks).toBe(4);
  });
});
