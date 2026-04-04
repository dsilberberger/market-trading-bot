import { computeReRiskCorridor } from '../src/core/capital';
import type { ReRiskCorridorState } from '../src/core/capital';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const variantConfig = require('../src/config/default.stateful_rerisk_corridor.position_size_scaled_risk_gate.json');

describe('stateful re-risk corridor', () => {
  it('leaves weak states unchanged', () => {
    const result = computeReRiskCorridor({
      config: variantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_off',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7
    });

    expect(result.active).toBe(false);
    expect(result.exitReason).toBe('regime_not_risk_on');
    expect(result.supplementalCapacityUsd).toBe(0);
  });

  it('enters on underinvested risk_on states and stays disabled in baseline', () => {
    const baseline = computeReRiskCorridor({
      config: baseConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7
    });
    const variant = computeReRiskCorridor({
      config: variantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7
    });

    expect(baseline.active).toBe(false);
    expect(baseline.exitReason).toBe('disabled');
    expect(variant.active).toBe(true);
    expect(variant.entryReason).toBe('risk_on_underinvested_entry');
    expect(variant.currentCorridorTargetPct).toBeCloseTo(0.2);
    expect(variant.supplementalCapacityUsd).toBe(0);
  });

  it('advances only after realized progress or catch-up and stays bounded by ceiling', () => {
    const entry = computeReRiskCorridor({
      config: variantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.52
    });
    const advance = computeReRiskCorridor({
      config: variantConfig as any,
      priorState: entry.state,
      asOf: '2025-01-08',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.52
    });
    const bounded = computeReRiskCorridor({
      config: variantConfig as any,
      priorState: {
        ...advance.state,
        currentCorridorTargetPct: 0.5,
        lastObservedEquityAllocationPct: 0.5
      },
      asOf: '2025-01-15',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.5,
      currentEquityMarketValueUsd: 50,
      navUsd: 100,
      favorableStateCeilingPct: 0.52
    });

    expect(advance.advanceReason).toBe('caught_up_to_corridor_target');
    expect(advance.currentCorridorTargetPct).toBeCloseTo(0.25);
    expect(advance.intendedIncrementalReRiskUsd).toBeCloseTo(5);
    expect(bounded.currentCorridorTargetPct).toBeCloseTo(0.52);
    expect(bounded.effectiveCeilingPct).toBeCloseTo(0.52);
  });

  it('pauses when realized progress stalls and exits once exposure recovers or regime weakens', () => {
    const priorState = {
      active: true,
      entryDate: '2025-01-01',
      entryEquityAllocationPct: 0.2,
      currentCorridorTargetPct: 0.3,
      favorableSequenceWeeks: 2,
      stallCount: 0,
      lastObservedEquityAllocationPct: 0.2,
      lastAdvanceDate: '2025-01-08',
      lastAction: 'advance' as const,
      lastExitReason: null
    };
    const paused = computeReRiskCorridor({
      config: variantConfig as any,
      priorState,
      asOf: '2025-01-15',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.205,
      currentEquityMarketValueUsd: 20.5,
      navUsd: 100,
      favorableStateCeilingPct: 0.6
    });
    const recovered = computeReRiskCorridor({
      config: variantConfig as any,
      priorState: paused.state,
      asOf: '2025-01-22',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.595,
      currentEquityMarketValueUsd: 59.5,
      navUsd: 100,
      favorableStateCeilingPct: 0.6
    });
    const downgraded = computeReRiskCorridor({
      config: variantConfig as any,
      priorState: paused.state,
      asOf: '2025-01-22',
      regimeLabel: 'neutral',
      currentEquityAllocationPct: 0.21,
      currentEquityMarketValueUsd: 21,
      navUsd: 100,
      favorableStateCeilingPct: 0.6
    });

    expect(paused.active).toBe(true);
    expect(paused.pauseReason).toBe('insufficient_realized_progress');
    expect(paused.currentCorridorTargetPct).toBeCloseTo(0.3);
    expect(paused.state.stallCount).toBe(1);
    expect(recovered.active).toBe(false);
    expect(recovered.exitReason).toBe('exposure_recovered');
    expect(downgraded.active).toBe(false);
    expect(downgraded.exitReason).toBe('regime_not_risk_on');
  });

  it('is deterministic across repeated favorable sequences', () => {
    const sequence = [
      {
        asOf: '2025-01-01',
        regimeLabel: 'risk_on',
        currentEquityAllocationPct: 0.2,
        currentEquityMarketValueUsd: 20
      },
      {
        asOf: '2025-01-08',
        regimeLabel: 'risk_on',
        currentEquityAllocationPct: 0.2,
        currentEquityMarketValueUsd: 20
      },
      {
        asOf: '2025-01-15',
        regimeLabel: 'risk_on',
        currentEquityAllocationPct: 0.26,
        currentEquityMarketValueUsd: 26
      },
      {
        asOf: '2025-01-22',
        regimeLabel: 'neutral',
        currentEquityAllocationPct: 0.26,
        currentEquityMarketValueUsd: 26
      }
    ];

    const runSequence = () => {
      let priorState: ReRiskCorridorState | undefined;
      return sequence.map((step) => {
        const result = computeReRiskCorridor({
          config: variantConfig as any,
          priorState,
          navUsd: 100,
          favorableStateCeilingPct: 0.6,
          ...step
        });
        priorState = result.state;
        return result;
      });
    };

    expect(runSequence()).toEqual(runSequence());
  });
});
