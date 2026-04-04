import { computeExposureStateController } from '../src/core/capital';
import type { ExposureStateControllerState } from '../src/core/capital';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const variantConfig = require('../src/config/default.stateful_rerisk_corridor_v2.position_size_scaled_risk_gate.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const v2VariantConfig = require('../src/config/default.incremental_exposure_delta_v2.json');

describe('exposure state controller', () => {
  it('stays disabled in baseline and enters on underinvested risk_on states in the variant', () => {
    const baseline = computeExposureStateController({
      config: baseConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });
    const variant = computeExposureStateController({
      config: variantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });

    expect(baseline.active).toBe(false);
    expect(baseline.controllerReason).toBe('disabled');
    expect(variant.active).toBe(true);
    expect(variant.controllerAction).toBe('entry');
    expect(variant.state.phase).toBe('building');
    expect(variant.targetCoreEquityPct).toBeCloseTo(0.2);
    expect(variant.requestedExposureDeltaUsd).toBe(0);
  });

  it('enforces the lower of favorable-state and system ceilings', () => {
    const result = computeExposureStateController({
      config: variantConfig as any,
      priorState: {
        active: true,
        phase: 'building',
        entryDate: '2025-01-01',
        entryEquityAllocationPct: 0.2,
        targetCoreEquityPct: 0.55,
        priorTargetCoreEquityPct: 0.5,
        favorableSequenceWeeks: 3,
        consecutiveStallWeeks: 0,
        lastRealizedEquityAllocationPct: 0.55,
        lastRequestedExposureDeltaUsd: 0,
        lastRealizedExposureDeltaPct: 0.05,
        lastAction: 'advance',
        lastReason: 'caught_up_to_target'
      },
      asOf: '2025-01-08',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.55,
      currentEquityMarketValueUsd: 55,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.58
    });

    expect(result.effectiveCeilingPct).toBeCloseTo(0.58);
    expect(result.targetCoreEquityPct).toBeCloseTo(0.58);
  });

  it('requires explicit realized progress before advancing target further', () => {
    const entry = computeExposureStateController({
      config: variantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });
    const paused = computeExposureStateController({
      config: variantConfig as any,
      priorState: entry.state,
      asOf: '2025-01-08',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.205,
      currentEquityMarketValueUsd: 20.5,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });
    const advanced = computeExposureStateController({
      config: variantConfig as any,
      priorState: paused.state,
      asOf: '2025-01-15',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.22,
      currentEquityMarketValueUsd: 22,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });

    expect(paused.controllerAction).toBe('pause');
    expect(paused.state.consecutiveStallWeeks).toBe(1);
    expect(paused.targetCoreEquityPct).toBeCloseTo(0.2);
    expect(advanced.controllerAction).toBe('advance');
    expect(advanced.controllerReason).toBe('progress_threshold_met');
    expect(advanced.targetCoreEquityPct).toBeCloseTo(0.27);
    expect(advanced.requestedExposureDeltaUsd).toBeCloseTo(5);
  });

  it('exits immediately on weak regimes or recovered exposure', () => {
    const priorState: ExposureStateControllerState = {
      active: true,
      phase: 'building',
      entryDate: '2025-01-01',
      entryEquityAllocationPct: 0.2,
      targetCoreEquityPct: 0.35,
      priorTargetCoreEquityPct: 0.3,
      favorableSequenceWeeks: 4,
      consecutiveStallWeeks: 0,
      lastRealizedEquityAllocationPct: 0.3,
      lastRequestedExposureDeltaUsd: 5,
      lastRealizedExposureDeltaPct: 0.02,
      lastAction: 'advance',
      lastReason: 'progress_threshold_met'
    };

    const downgraded = computeExposureStateController({
      config: variantConfig as any,
      priorState,
      asOf: '2025-01-22',
      regimeLabel: 'neutral',
      currentEquityAllocationPct: 0.3,
      currentEquityMarketValueUsd: 30,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });
    const recovered = computeExposureStateController({
      config: variantConfig as any,
      priorState,
      asOf: '2025-01-22',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.595,
      currentEquityMarketValueUsd: 59.5,
      navUsd: 100,
      favorableStateCeilingPct: 0.6,
      systemAllowedEquityCeilingPct: 0.6
    });

    expect(downgraded.active).toBe(false);
    expect(downgraded.controllerReason).toBe('regime_not_risk_on');
    expect(recovered.active).toBe(false);
    expect(recovered.controllerReason).toBe('exposure_recovered');
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
        currentEquityAllocationPct: 0.205,
        currentEquityMarketValueUsd: 20.5
      },
      {
        asOf: '2025-01-15',
        regimeLabel: 'risk_on',
        currentEquityAllocationPct: 0.22,
        currentEquityMarketValueUsd: 22
      },
      {
        asOf: '2025-01-22',
        regimeLabel: 'neutral',
        currentEquityAllocationPct: 0.22,
        currentEquityMarketValueUsd: 22
      }
    ];

    const runSequence = () => {
      let priorState: ExposureStateControllerState | undefined;
      return sequence.map((step) => {
        const result = computeExposureStateController({
          config: variantConfig as any,
          priorState,
          navUsd: 100,
          favorableStateCeilingPct: 0.6,
          systemAllowedEquityCeilingPct: 0.6,
          ...step
        });
        priorState = result.state;
        return result;
      });
    };

    expect(runSequence()).toEqual(runSequence());
  });

  it('persists stalls without marching the target upward blindly', () => {
    const entry = computeExposureStateController({
      config: variantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });
    const stalledOnce = computeExposureStateController({
      config: variantConfig as any,
      priorState: entry.state,
      asOf: '2025-01-08',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });
    const stalledTwice = computeExposureStateController({
      config: variantConfig as any,
      priorState: stalledOnce.state,
      asOf: '2025-01-15',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7
    });

    expect(stalledOnce.controllerAction).toBe('pause');
    expect(stalledOnce.targetCoreEquityPct).toBeCloseTo(0.2);
    expect(stalledTwice.controllerAction).toBe('pause');
    expect(stalledTwice.targetCoreEquityPct).toBeCloseTo(0.2);
    expect(stalledTwice.state.consecutiveStallWeeks).toBe(2);
  });

  it('jumps to a minimum executable delta target in v2 instead of emitting a micro request', () => {
    const result = computeExposureStateController({
      config: v2VariantConfig as any,
      asOf: '2025-01-01',
      regimeLabel: 'risk_on',
      currentEquityAllocationPct: 0.2,
      currentEquityMarketValueUsd: 20,
      navUsd: 100,
      favorableStateCeilingPct: 0.7,
      systemAllowedEquityCeilingPct: 0.7,
      minimumExecutableDeltaUsd: 18
    });

    expect(result.controllerAction).toBe('entry');
    expect(result.minimumExecutableDeltaUsd).toBeCloseTo(18);
    expect(result.requestedExposureDeltaUsd).toBeCloseTo(18);
    expect(result.targetCoreEquityPct).toBeCloseTo(0.38);
  });
});
