import { computeReRiskSequenceCatchUp } from '../src/core/capital';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseConfig = require('../src/config/default.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const variantConfig = require('../src/config/default.risk_on_sequence_catchup.position_size_scaled_risk_gate.json');

describe('re-risk sequence catch-up', () => {
  it('leaves clearly weak states unchanged', () => {
    const result = computeReRiskSequenceCatchUp({
      config: variantConfig as any,
      regimeLabel: 'risk_off',
      timeInRegimeWeeks: 4,
      currentEquityAllocationPct: 0.15,
      optionsReserveCashUsd: 100
    });

    expect(result.active).toBe(false);
    expect(result.supplementUsd).toBe(0);
    expect(result.reason).toBe('not_risk_on');
  });

  it('requires a persistent favorable sequence and a low-equity state', () => {
    const tooEarly = computeReRiskSequenceCatchUp({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 1,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });
    const alreadyRecovered = computeReRiskSequenceCatchUp({
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

  it('ramps the supplement across consecutive favorable weeks from a low-equity state', () => {
    const week2 = computeReRiskSequenceCatchUp({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 2,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });
    const week3 = computeReRiskSequenceCatchUp({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 3,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });
    const week5 = computeReRiskSequenceCatchUp({
      config: variantConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 5,
      currentEquityAllocationPct: 0.2,
      optionsReserveCashUsd: 100
    });

    expect(week2.active).toBe(true);
    expect(week2.supplementUsd).toBeCloseTo(20);
    expect(week3.supplementUsd).toBeCloseTo(40);
    expect(week5.supplementUsd).toBeCloseTo(60);
    expect(week5.supplementUsd).toBeGreaterThanOrEqual(week3.supplementUsd);
  });

  it('preserves baseline behavior when the feature is not configured', () => {
    const result = computeReRiskSequenceCatchUp({
      config: baseConfig as any,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 6,
      currentEquityAllocationPct: 0.1,
      optionsReserveCashUsd: 100
    });

    expect(result.active).toBe(false);
    expect(result.supplementUsd).toBe(0);
    expect(result.reason).toBe('disabled');
  });
});
