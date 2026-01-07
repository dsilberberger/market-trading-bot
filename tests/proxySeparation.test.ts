import fs from 'fs';
import path from 'path';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { RegimeContext, SymbolFeature } from '../src/core/types';

// Ensure confidence proxies are separate from execution proxies.

const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.small.json'), 'utf-8'));
const proxies = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/proxies_small.json'), 'utf-8'));

describe('proxy separation (confidence vs execution)', () => {
  it('calibrator uses confidence proxy (SPY) and not execution proxies', () => {
    const regimes: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.2 } };
    const features: SymbolFeature[] = [
      {
        symbol: 'VTI',
        price: 100,
        barInterval: '1d',
        historySamples: 10,
        historyUniqueCloses: 10,
        return60dPctileBucket: 'unknown',
        vol20dPctileBucket: 'unknown',
        above200dma: false
      } as any,
      {
        symbol: 'SPY',
        price: 100,
        barInterval: '1d',
        historySamples: 300,
        historyUniqueCloses: 300,
        return60dPctileBucket: 'mid',
        vol20dPctileBucket: 'mid',
        above200dma: true
      } as any
    ];
    const res = calibrateEquityConfidence({
      asOf: '2024-02-01',
      runId: 'proxy-separation',
      regimes,
      features,
      config: cfg,
      proxiesMap: proxies,
      prior: { label: 'risk_off', timeInRegimeWeeks: 2 }
    });
    expect(res.diagnostics?.proxy?.symbol).toBe('SPY');
    // execution proxies for VTI exist (ITOT/SCHB) but should not be chosen for confidence
    expect(res.diagnostics?.proxy?.symbol).not.toBe('ITOT');
    expect(res.diagnostics?.proxy?.symbol).not.toBe('SCHB');
  });
});
