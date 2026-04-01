import { validateTradeIntent } from '../src/core/schema';
import { applyDecisionPolicyGate } from '../src/risk/decisionPolicyGate';
import { derivePolicyExposureCap } from '../src/risk/policyExposureCap';

const makeIntent = (netExposureTarget: number, notionalUSD = 700) =>
  ({
    asOf: '2026-04-01T12:00',
    universe: ['VTI'],
    orders: [
      {
        symbol: 'VTI',
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD,
        thesis: 'test',
        invalidation: 'test',
        confidence: 0.8,
        portfolioLevel: { targetHoldDays: 30, netExposureTarget }
      }
    ]
  }) as const;

const makeContext = (label: 'neutral' | 'risk_on' | 'risk_off', vol: 'low' | 'rising' | 'stressed', confidence: number) =>
  ({
    regimes: {
      equityRegime: { label, confidence, transitionRisk: 'low' },
      volRegime: { label: vol }
    },
    dataQuality: { round1: [] }
  }) as any;

const makePortfolio = () =>
  ({
    cash: 1000,
    equity: 1000,
    holdings: []
  }) as any;

const makeConfig = () =>
  ({
    policyGateMode: 'scale',
    minCashPct: 0
  }) as any;

describe('netExposureTarget authority reduction', () => {
  it('keeps neutral low-vol policy cap at the smoothed floor even when proposal requests 0.35', () => {
    const intent = makeIntent(0.35, 400);
    const llmContext = makeContext('neutral', 'low', 0.2);
    const result = applyDecisionPolicyGate(intent as any, llmContext, makePortfolio(), makeConfig());

    expect(derivePolicyExposureCap({ equityConfidence: 0.2, regimeLabel: 'neutral', volLabel: 'low' })).toBe(0.35);
    expect(result.policyApplied.exposureCap).toBe(0.35);
    expect(result.orders[0].notionalUSD).toBe(350);
  });

  it('ignores proposal netExposureTarget when non-neutral low-confidence policy cap is 0.35', () => {
    const intent = makeIntent(0.1, 700);
    const llmContext = makeContext('risk_on', 'low', 0.2);
    const result = applyDecisionPolicyGate(intent as any, llmContext, makePortfolio(), makeConfig());

    expect(derivePolicyExposureCap({ equityConfidence: 0.2, regimeLabel: 'risk_on', volLabel: 'low' })).toBe(0.35);
    expect(result.policyApplied.exposureCap).toBe(0.35);
    expect(result.orders[0].notionalUSD).toBe(350);
    expect(result.policyApplied.requestedNetExposureTarget).toBe(0.1);
  });

  it('retains netExposureTarget in schema validation and gate output artifacts', () => {
    const intent = makeIntent(0.35, 400);
    const validation = validateTradeIntent(intent, ['VTI']);
    const result = applyDecisionPolicyGate(intent as any, makeContext('neutral', 'low', 0.2), makePortfolio(), makeConfig());

    expect(validation.success).toBe(true);
    expect(result.orders[0].portfolioLevel.netExposureTarget).toBe(0.35);
    expect(result.policyApplied.requestedNetExposureTarget).toBe(0.35);
  });

  it('keeps planning and gating aligned on the same policy-owned exposure cap', () => {
    const expectedExposureCap = derivePolicyExposureCap({
      equityConfidence: 0.5,
      regimeLabel: 'neutral',
      volLabel: 'low',
      hasMacroLag: false,
      hasCoarsePercentiles: false,
      transitionRisk: 'low'
    });
    const result = applyDecisionPolicyGate(makeIntent(0.2, 600) as any, makeContext('neutral', 'low', 0.5), makePortfolio(), makeConfig());

    expect(expectedExposureCap).toBe(0.35);
    expect(result.policyApplied.baseExposureCap).toBe(expectedExposureCap);
    expect(result.policyApplied.exposureCap).toBe(expectedExposureCap);
  });
});
