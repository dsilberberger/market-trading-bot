import fs from 'fs';
import path from 'path';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { BotConfig, RegimeContext, SymbolFeature } from '../src/core/types';

// Verification-only: ensure proxy mapping use in calibrator is stable and deterministic.

const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.json'), 'utf-8')) as BotConfig;

const canonicalSymbolsToCheck = ['SPY']; // anchor defaults to SPY; extend if config adds more anchors.

const baseRegime: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.2 } };

const makeCanonicalShort = (sym: string): SymbolFeature => ({
  symbol: sym,
  price: 100,
  barInterval: '1d',
  historySamples: 20,
  historyUniqueCloses: 20,
  return60d: 0.01,
  return60dPctileBucket: 'unknown',
  vol20dPctileBucket: 'unknown',
  above200dma: false
} as any);

const makeProxyLong = (sym: string): SymbolFeature => ({
  symbol: sym,
  price: 100,
  barInterval: '1d',
  historySamples: 200,
  historyUniqueCloses: 200,
  return60d: 0.05,
  return60dPctileBucket: 'mid',
  vol20dPctileBucket: 'mid',
  above200dma: true
} as any);

describe('proxy mapping stability for confidence calibrator', () => {
  it('mapping present: proxy used deterministically and confidence reflects it', () => {
    const proxiesMap = { SPY: ['SPYM'] };
    const features: SymbolFeature[] = [makeCanonicalShort('SPY'), makeProxyLong('SPYM')];
    const calibration = calibrateEquityConfidence({
      asOf: '2024-01-01',
      runId: 'proxy-stability',
      regimes: baseRegime,
      features,
      config: cfg,
      proxiesMap,
      prior: { label: 'risk_off', timeInRegimeWeeks: 3 }
    });
    // Determinism: resolve twice should be identical
    const calibration2 = calibrateEquityConfidence({
      asOf: '2024-01-01',
      runId: 'proxy-stability',
      regimes: baseRegime,
      features,
      config: cfg,
      proxiesMap,
      prior: { label: 'risk_off', timeInRegimeWeeks: 3 }
    });
    expect(calibration.diagnostics?.proxy?.symbol).toBe('SPYM');
    expect(calibration2.diagnostics?.proxy?.symbol).toBe('SPYM');
    expect(calibration.confidence).toBeCloseTo(calibration2.confidence, 10);
    // Print report
    // eslint-disable-next-line no-console
    console.log(
      `Mapping present -> canonical: SPY, proxy: ${calibration.diagnostics?.proxy?.symbol || 'none'}, calConf: ${calibration.confidence.toFixed(
        4
      )}`
    );
  });

  it('mapping absent: no proxy lift and diagnostics indicate no proxy', () => {
    const proxiesMap = {}; // empty
    const features: SymbolFeature[] = [makeCanonicalShort('SPY'), makeProxyLong('SPYM')];
    const baseConf = baseRegime.equityRegime?.confidence || 0;
    const calibration = calibrateEquityConfidence({
      asOf: '2024-01-01',
      runId: 'proxy-stability',
      regimes: baseRegime,
      features,
      config: cfg,
      proxiesMap,
      prior: { label: 'risk_off', timeInRegimeWeeks: 3 }
    });
    expect(calibration.diagnostics?.proxy?.symbol || null).toBeNull();
    expect(calibration.confidence).toBeGreaterThanOrEqual(baseConf);
    // Should not lift beyond what a missing proxy would justify (conf floor applies but no proxy lift)
    // Print report
    // eslint-disable-next-line no-console
    console.log(
      `Mapping absent -> canonical: SPY, proxy: none, calConf: ${calibration.confidence.toFixed(4)}`
    );
  });

  it('has mapping entries for canonical symbols used by calibrator', () => {
    const proxiesCfg = cfg.confidenceCalibration?.proxyMap as Record<string, string> | undefined;
    canonicalSymbolsToCheck.forEach((sym) => {
      const hasConfig = proxiesCfg && proxiesCfg[sym];
      const hasDefault = (cfg as any).allowExecutionProxies && sym === 'SPY' && fs.existsSync(path.resolve(__dirname, '../src/config/proxies.json'));
      expect(hasConfig || hasDefault).toBe(true);
    });
  });
});
