import { runSleeveLifecycle } from '../src/dislocation/sleeveLifecycle';
import { detectDislocation } from '../src/dislocation/dislocationDetector';
import { DislocationSleeveState } from '../src/dislocation/sleeveState';
import { PriceBar } from '../src/data/marketData.types';
import fs from 'fs';
import path from 'path';

const resetState = () => {
  const p = path.resolve(process.cwd(), 'data_cache', 'dislocation_sleeve_state.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
};

const baseConfig: any = {
  dislocation: {
    enabled: true,
    anchorSymbol: 'SPY',
    triggerFastDrawdownPct: 0.05,
    triggerSlowDrawdownPct: 0.1,
    confirmBreadth: false,
    opportunisticExtraExposurePct: 0.15,
    maxTotalExposureCapPct: 0.6,
    durationWeeksAdd: 3,
    durationWeeksHold: 2,
    cooldownWeeks: 2,
    deploymentTargets: [{ symbol: 'SPYM', weight: 1 }],
    earlyExit: {
      enabled: true,
      riskOffConfidenceThreshold: 0.7,
      requiresRiskOffLabel: true,
      deepDrawdownFailsafePct: 0.3
    }
  }
};

const makeBars = (prices: number[]): PriceBar[] =>
  prices.map((p, i) => ({
    close: p,
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    time: new Date(Date.UTC(2025, 0, i + 1)).toISOString()
  }));

describe('dislocation lifecycle', () => {
  beforeEach(() => resetState());

  it('triggers ADD then transitions to HOLD then REINTEGRATE', () => {
    // simulate a 15% slow drawdown to trigger
    const history = { SPY: makeBars([100, 98, 95, 90, 85]) };
    const quotes = { SPY: 85 };
    const asOf = '2025-01-15';
    const det = detectDislocation(asOf, baseConfig as any, history as any, quotes);
    expect(det.active).toBe(true);
    const life1 = runSleeveLifecycle({
      asOf,
      config: baseConfig as any,
      dislocationActive: det.active,
      anchorPrice: quotes.SPY,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    expect(life1.allowAdd).toBe(true);
    // Advance beyond add window into hold
    const life2 = runSleeveLifecycle({
      asOf: '2025-02-15',
      config: baseConfig as any,
      dislocationActive: true,
      anchorPrice: 88,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    expect(life2.protectFromSells).toBe(true);
    expect(life2.allowAdd).toBe(false);
    // Advance beyond hold into reintegrate
    const life3 = runSleeveLifecycle({
      asOf: '2025-03-15',
      config: baseConfig as any,
      dislocationActive: false,
      anchorPrice: 95,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    expect(life3.allowReintegration).toBe(true);
    expect(life3.protectFromSells).toBe(false);
  });

  it('early exit on risk_off high confidence', () => {
    const history = { SPY: makeBars([100, 98, 95, 90, 89]) };
    const quotes = { SPY: 89 };
    const asOf = '2025-01-15';
    const det = detectDislocation(asOf, baseConfig as any, history as any, quotes);
    runSleeveLifecycle({
      asOf,
      config: baseConfig as any,
      dislocationActive: det.active,
      anchorPrice: quotes.SPY,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    const exitLife = runSleeveLifecycle({
      asOf: '2025-01-22',
      config: baseConfig as any,
      dislocationActive: true,
      anchorPrice: 88,
      regimes: { equityRegime: { label: 'risk_off', confidence: 0.75 } }
    });
    expect(exitLife.allowReintegration).toBe(true);
    expect(exitLife.protectFromSells).toBe(false);
  });
});
