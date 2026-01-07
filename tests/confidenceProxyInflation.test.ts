import fs from 'fs';
import path from 'path';
import { calibrateEquityConfidence } from '../src/strategy/confidenceCalibrator';
import { computeCoreDeployPct } from '../src/core/capital';
import { BotConfig, RegimeContext, SymbolFeature } from '../src/core/types';

// Diagnostic: ensure proxy-based confidence calibration cannot inflate deployPct improperly.

const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/config/default.json'), 'utf-8')) as BotConfig;

const baseRegime: RegimeContext = { equityRegime: { label: 'risk_off', confidence: 0.2 } };

const canonicalShort: SymbolFeature = {
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

type ProxyVariant = 'bullish' | 'bearish' | 'low_quality';

const makeProxy = (variant: ProxyVariant): SymbolFeature => {
  if (variant === 'bullish') {
    return {
      symbol: 'SPYM',
      price: 100,
      barInterval: '1d',
      historySamples: 200,
      historyUniqueCloses: 200,
      return60d: 0.1,
      return60dPctileBucket: 'high',
      vol20dPctileBucket: 'low',
      above200dma: true
    } as any;
  }
  if (variant === 'bearish') {
    return {
      symbol: 'SPYM',
      price: 100,
      barInterval: '1d',
      historySamples: 200,
      historyUniqueCloses: 200,
      return60d: -0.05,
      return60dPctileBucket: 'low',
      vol20dPctileBucket: 'high',
      above200dma: false
    } as any;
  }
  return {
    symbol: 'SPYM',
    price: 100,
    barInterval: '1d',
    historySamples: 200,
    historyUniqueCloses: 5,
    return60d: 0.02,
    return60dPctileBucket: 'unknown',
    vol20dPctileBucket: 'unknown',
    above200dma: false
  } as any;
};

const runCase = (variant: ProxyVariant) => {
  const features: SymbolFeature[] = [canonicalShort, makeProxy(variant)];
  const calibration = calibrateEquityConfidence({
    asOf: '2024-01-01',
    runId: 'diagnostic-inflation',
    regimes: baseRegime,
    features,
    config: cfg,
    proxiesMap: { SPY: ['SPYM'] },
    prior: { label: 'risk_off', timeInRegimeWeeks: 4 } // mid-ramp to avoid zero effect
  });
  const regimesAfter: RegimeContext = { equityRegime: { label: 'risk_off', confidence: calibration.confidence } };
  const deploy = computeCoreDeployPct(regimesAfter, cfg);
  return {
    variant,
    calibratedConf: calibration.confidence,
    confidenceScale: deploy.confidenceScale,
    deployPct: deploy.deployPct,
    proxySymbol: calibration.diagnostics?.proxy?.symbol,
    proxyConf: calibration.diagnostics?.proxy?.confidence
  };
};

describe('proxy confidence inflation guard (diagnostic)', () => {
  it('shows deployPct ordering and bounds across proxy cases', () => {
    const cases = ['bullish', 'bearish', 'low_quality'] as ProxyVariant[];
    const results = cases.map(runCase);

    const header = ['Case', 'calConf', 'confScale', 'deployPct', 'proxy', 'proxyConf'].join(' | ');
    const rows = results.map((r) =>
      [
        r.variant,
        r.calibratedConf.toFixed(4),
        r.confidenceScale.toFixed(2),
        r.deployPct.toFixed(4),
        r.proxySymbol || '',
        r.proxyConf !== undefined ? r.proxyConf.toFixed(4) : ''
      ].join(' | ')
    );
    // eslint-disable-next-line no-console
    console.log('\nProxy calibration comparison:\n' + [header, ...rows].join('\n') + '\n');

    const bullish = results.find((r) => r.variant === 'bullish')!;
    const bearish = results.find((r) => r.variant === 'bearish')!;
    const lowq = results.find((r) => r.variant === 'low_quality')!;

    expect(bearish.deployPct).toBeLessThanOrEqual(bullish.deployPct + 1e-6);
    expect(lowq.deployPct).toBeLessThanOrEqual(bullish.deployPct + 1e-6);
    [bullish, bearish, lowq].forEach((r) => {
      expect(r.deployPct).toBeLessThanOrEqual(0.35 + 1e-9); // risk_off cap
      expect(r.calibratedConf).toBeGreaterThanOrEqual(0);
      expect(r.calibratedConf).toBeLessThanOrEqual(1);
    });
  });
});
