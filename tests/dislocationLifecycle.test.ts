import { runSleeveLifecycle } from '../src/dislocation/sleeveLifecycle';
import { detectDislocation } from '../src/dislocation/dislocationDetector';
import { DislocationSleeveState } from '../src/dislocation/sleeveState';
import { PriceBar } from '../src/data/marketData.types';
import fs from 'fs';
import path from 'path';
import { deriveLifecycleBooleans } from '../src/dislocation/sleeveLifecycle';

const resetState = () => {
  const p = path.resolve(process.cwd(), 'data_cache', 'dislocation_sleeve_state.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const p2 = path.resolve(process.cwd(), 'data_cache', 'dislocation_state.json');
  if (fs.existsSync(p2)) fs.unlinkSync(p2);
};

const baseConfig: any = {
  dislocation: {
    enabled: true,
    anchorSymbol: 'SPY',
    minActiveTier: 1,
    barInterval: '1w',
    fastWindowWeeks: 1,
    slowWindowWeeks: 4,
    peakLookbackWeeks: 26,
    tiers: [
      { tier: 0, name: 'inactive', peakDrawdownGte: 0, overlayExtraExposurePct: 0 },
      { tier: 1, name: 'mild', peakDrawdownGte: 0.1, overlayExtraExposurePct: 0.15 },
      { tier: 2, name: 'dislocation', peakDrawdownGte: 0.2, overlayExtraExposurePct: 0.3 }
    ],
    fastDrawdownEscalation: {
      enabled: true,
      tier2FastDrawdownGte: 0.12,
      tier3FastDrawdownGte: 0.18
    },
    slowDrawdownEscalation: {
      enabled: true,
      tier2SlowDrawdownGte: 0.15,
      tier3SlowDrawdownGte: 0.25
    },
    tierHysteresisPct: 0.02,
    minWeeksBetweenTierChanges: 1,
    confirmBreadth: false,
    maxTotalExposureCapPct: 0.7,
    durationWeeksAdd: 3,
    durationWeeksHold: 2,
    cooldownWeeks: 2,
    overlayTargets: [{ symbol: 'SPYM', weight: 1 }],
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
    expect(det.tierEngaged).toBe(true);
    const life1 = runSleeveLifecycle({
      asOf,
      config: baseConfig as any,
      dislocationActive: det.tierEngaged,
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

  it('uses date-based progression for many weeks', () => {
    const history = { SPY: makeBars([100, 98, 95, 90, 85]) };
    const quotes = { SPY: 85 };
    const det = detectDislocation('2025-01-07', baseConfig as any, history as any, quotes);
    runSleeveLifecycle({
      asOf: '2025-01-07',
      config: baseConfig as any,
      dislocationActive: det.tierEngaged,
      anchorPrice: quotes.SPY,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    // After add window ends -> HOLD
    const lifeHold = runSleeveLifecycle({
      asOf: '2025-02-05',
      config: baseConfig as any,
      dislocationActive: true,
      anchorPrice: 90,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    expect(lifeHold.state.phase).toBe('HOLD');
    // After hold window -> REINTEGRATE
    const lifeReint = runSleeveLifecycle({
      asOf: '2025-03-15',
      config: baseConfig as any,
      dislocationActive: false,
      anchorPrice: 95,
      regimes: { equityRegime: { label: 'neutral', confidence: 0.5 } }
    });
    expect(lifeReint.allowReintegration).toBe(true);
  });

  it('derives controls from phase consistently', () => {
    const phases: Array<DislocationSleeveState['phase']> = ['ADD', 'HOLD', 'REINTEGRATE', 'INACTIVE'];
    for (const ph of phases) {
      const derived = deriveLifecycleBooleans(ph);
      if (ph === 'ADD') expect(derived.active).toBe(true);
      if (ph === 'REINTEGRATE') expect(derived.protectFromSells).toBe(false);
    }
  });

  it('early exit on risk_off high confidence', () => {
    const history = { SPY: makeBars([100, 98, 95, 90, 89]) };
    const quotes = { SPY: 89 };
    const asOf = '2025-01-15';
    const det = detectDislocation(asOf, baseConfig as any, history as any, quotes);
    runSleeveLifecycle({
      asOf,
      config: baseConfig as any,
      dislocationActive: det.tierEngaged,
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
