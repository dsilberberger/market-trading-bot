import {
  computeCoreBuyCapacityUsd,
  computeCoreCapacityHeadroomExpansion
} from '../src/core/capital';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const variantConfig = require('../src/config/default.risk_on_headroom_expansion.position_size_scaled_risk_gate.json');

describe('core capacity headroom expansion', () => {
  it('leaves weak states unchanged', () => {
    const result = computeCoreCapacityHeadroomExpansion({
      config: variantConfig as any,
      regimeLabel: 'risk_off',
      timeInRegimeWeeks: 4,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });

    expect(result.active).toBe(false);
    expect(result.supplementUsd).toBe(0);
    expect(result.reason).toBe('not_risk_on');
  });

  it('requires a persistent favorable sequence and low-equity state', () => {
    const tooEarly = computeCoreCapacityHeadroomExpansion({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 1,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });
    const alreadyRecovered = computeCoreCapacityHeadroomExpansion({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 4,
      currentEquityAllocationPct: 0.45,
      optionsReserveCashUsd: 100
    });

    expect(tooEarly.supplementUsd).toBe(0);
    expect(tooEarly.reason).toBe('insufficient_sequence');
    expect(alreadyRecovered.supplementUsd).toBe(0);
    expect(alreadyRecovered.reason).toBe('not_underinvested');
  });

  it('produces higher core buy capacity in favorable underinvested states', () => {
    const baselineCapacity = computeCoreBuyCapacityUsd({
      coreCashUsd: 120,
      coreHeadroomUsd: 120,
      estimatedSellProceedsUsd: 0
    });
    const expansion = computeCoreCapacityHeadroomExpansion({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 3,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });
    const expandedCapacity = computeCoreBuyCapacityUsd({
      coreCashUsd: 120,
      coreHeadroomUsd: 120,
      estimatedSellProceedsUsd: 0,
      supplementalCapacityUsd: expansion.supplementUsd
    });

    expect(expansion.active).toBe(true);
    expect(expansion.supplementUsd).toBeCloseTo(40);
    expect(expandedCapacity).toBeCloseTo(160);
    expect(expandedCapacity).toBeGreaterThan(baselineCapacity);
  });

  it('remains bounded and deterministic', () => {
    const first = computeCoreCapacityHeadroomExpansion({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 10,
      currentEquityAllocationPct: 0.1,
      optionsReserveCashUsd: 100
    });
    const second = computeCoreCapacityHeadroomExpansion({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 10,
      currentEquityAllocationPct: 0.1,
      optionsReserveCashUsd: 100
    });
    const baseline = computeCoreCapacityHeadroomExpansion({
      config: baseConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 10,
      currentEquityAllocationPct: 0.1,
      optionsReserveCashUsd: 100
    });

    expect(first.supplementUsd).toBeCloseTo(60);
    expect(first.supplementUsd).toBe(second.supplementUsd);
    expect(baseline.supplementUsd).toBe(0);
    expect(baseline.reason).toBe('disabled');
  });
});
