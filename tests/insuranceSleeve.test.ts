import fs from 'fs';
import path from 'path';
import { planInsuranceSleeve, saveInsuranceState, selectInsuranceContract } from '../src/sleeves/insuranceSleeve';
import { BotConfig } from '../src/core/types';

const baseConfig: BotConfig = {
  startingCapitalUSD: 250,
  maxPositions: 4,
  rebalanceDay: 'FRIDAY',
  maxTradesPerRun: 4,
  maxPositionPct: 0.35,
  maxWeeklyDrawdownPct: 0.1,
  minCashPct: 0,
  maxNotionalTradedPctPerRun: 1,
  minHoldHours: 0,
  cadence: 'weekly',
  round0MacroLagPolicy: 'flags_warn',
  macroLagWarnDays: 45,
  macroLagErrorDays: 120,
  minExecutableNotionalUSD: 1,
  fractionalSharesSupported: true,
  allowExecutionProxies: true,
  proxiesFile: 'src/config/proxies.json',
  proxySelectionMode: 'first_executable',
  maxProxyTrackingErrorAbs: 0.1,
  enableExposureGrouping: true,
  exposureGroupsFile: 'src/config/exposure_groups.json',
  canonicalizeExposureGroups: true,
  canonicalizeOnlyInPhase: ['REINTEGRATE'],
  canonicalizeMaxNotionalPctPerRun: 0.1,
  canonicalizeMinDriftToAct: 0.05,
  canonicalizeOnlyIfAffordable: true,
  universeFile: 'src/config/universe.json',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: false,
  requireApproval: true,
  optionsUnderlyings: ['SPY'],
  hedgeProxyPolicy: { hedgePreferred: ['SPY'] },
  insurance: {
    spendPct: 0.85,
    minMonths: 3,
    maxMonths: 6,
    minMoneyness: 0.95,
    maxMoneyness: 1.0,
    limitPriceBufferPct: 0.05,
    closeWithinDays: 21,
    allowExpire: false
  },
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

const resetState = (env: string, account: string) => {
  const fname = ['insurance_state', env, account].join('.') + '.json';
  const statePath = path.resolve(process.cwd(), 'data_cache', fname);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
};

const buildStressInput = (accountKey: string, asOf: string, overrides: Partial<Parameters<typeof planInsuranceSleeve>[0]> = {}) => ({
  runId: `run-${accountKey}-${asOf}`,
  asOf,
  config: baseConfig,
  arbitratorAllowed: true,
  reserveBudget: 10000,
  reservePoolUsd: 10000,
  cashAvailable: 10000,
  quotes: { SPY: 100 },
  regimes: { equityRegime: { label: 'risk_off', confidence: 0.9 }, volRegime: { label: 'stressed', confidence: 0.9 } } as any,
  dislocationState: {
    active: true,
    phase: 'ADD',
    currentTier: 2,
    triggeredAtISO: '2025-01-01T16:00:00.000Z'
  },
  env: 'test-insurance',
  accountKey,
  ...overrides
});

describe('insurance sleeve activation', () => {
  it('does not open on risk_off alone without confirmed dislocation stress', async () => {
    resetState('test-insurance', 'risk-off-only');
    const res = await planInsuranceSleeve(
      buildStressInput('risk-off-only', '2025-01-01', {
        dislocationState: {
          active: false,
          phase: 'INACTIVE',
          currentTier: 0
        }
      })
    );

    expect(res.plannedAction).toBe('NONE');
    expect(res.reason).toContain('active dislocation');
  });

  it('opens only after two confirmed dislocation-stress steps', async () => {
    resetState('test-insurance', 'confirmed-entry');
    const first = await planInsuranceSleeve(buildStressInput('confirmed-entry', '2025-01-01'));
    const second = await planInsuranceSleeve(buildStressInput('confirmed-entry', '2025-01-08'));

    expect(first.plannedAction).toBe('NONE');
    expect(first.reason).toContain('2-step stress confirmation');
    expect(second.plannedAction).toBe('OPEN');
    expect(second.order).toBeTruthy();
    expect(second.reserveContext?.entryTargetUsd).toBeCloseTo(1200, 6);
  });

  it('opens immediately on panic-tier override and adds bounded tranches only while panic persists', async () => {
    resetState('test-insurance', 'panic-entry');
    const panicState = {
      active: true,
      phase: 'ADD',
      currentTier: 3,
      triggeredAtISO: '2025-01-01T16:00:00.000Z'
    };
    const open = await planInsuranceSleeve(
      buildStressInput('panic-entry', '2025-01-01', {
        dislocationState: panicState
      })
    );
    const add = await planInsuranceSleeve(
      buildStressInput('panic-entry', '2025-01-08', {
        dislocationState: panicState,
        optionPositions: [
          {
            underlying: 'SPY',
            optionSymbol: 'SPY:PUT:95:2025-04-01',
            type: 'PUT',
            strike: 95,
            expiry: '2025-04-01',
            contracts: 2,
            multiplier: 100,
            avgOpenPrice: 5.526315789,
            openDate: '2025-01-01',
            marketPrice: 5,
            marketValueUsd: 1000,
            unrealizedPnlUsd: -105.26
          }
        ]
      })
    );

    expect(open.plannedAction).toBe('OPEN');
    expect(open.reserveContext?.entryTargetUsd).toBeCloseTo(1200, 6);
    expect(add.plannedAction).toBe('OPEN');
    expect(add.reserveContext?.entryTargetUsd).toBeCloseTo(800, 6);
    expect(add.reserveContext?.trancheCount).toBe(2);
    expect(add.flags.some((flag) => flag.code === 'INSURANCE_ADD_TRANCHE_PLANNED')).toBe(true);
  });

  it('closes only after two normalized steps once stress ends', async () => {
    resetState('test-insurance', 'normalized-exit');
    await planInsuranceSleeve(
      buildStressInput('normalized-exit', '2025-01-01', {
        dislocationState: {
          active: true,
          phase: 'ADD',
          currentTier: 3,
          triggeredAtISO: '2025-01-01T16:00:00.000Z'
        }
      })
    );

    const position = {
      underlying: 'SPY',
      optionSymbol: 'SPY:PUT:95:2025-04-01',
      type: 'PUT' as const,
      strike: 95,
      expiry: '2025-04-01',
      contracts: 2,
      multiplier: 100,
      avgOpenPrice: 5.5,
      openDate: '2025-01-01',
      marketPrice: 4.5,
      marketValueUsd: 900,
      unrealizedPnlUsd: -200
    };

    const firstNormalization = await planInsuranceSleeve(
      buildStressInput('normalized-exit', '2025-01-08', {
        regimes: { equityRegime: { label: 'neutral', confidence: 0.7 }, volRegime: { label: 'low', confidence: 0.8 } } as any,
        dislocationState: {
          active: false,
          phase: 'INACTIVE',
          currentTier: 0
        },
        optionPositions: [position]
      })
    );
    const secondNormalization = await planInsuranceSleeve(
      buildStressInput('normalized-exit', '2025-01-15', {
        regimes: { equityRegime: { label: 'neutral', confidence: 0.7 }, volRegime: { label: 'low', confidence: 0.8 } } as any,
        dislocationState: {
          active: false,
          phase: 'INACTIVE',
          currentTier: 0
        },
        optionPositions: [position]
      })
    );

    expect(firstNormalization.plannedAction).toBe('HOLD');
    expect(secondNormalization.plannedAction).toBe('CLOSE');
    expect(secondNormalization.flags.some((flag) => flag.code === 'INSURANCE_CLOSE_CONFIRMED_NORMALIZATION')).toBe(true);
  });

  it('rolls near expiry when confirmed stress persists', async () => {
    resetState('test-insurance', 'roll-forward');
    saveInsuranceState(
      {
        status: 'DEPLOYED',
        openedRunId: 'run-roll-forward',
        openedAsOf: '2025-01-01',
        underlying: 'SPY',
        strike: 95,
        expiry: '2025-01-22',
        contracts: 2,
        premiumUSD: 1100,
        activeEpisodeId: 'episode-1',
        stagedEntryCount: 1,
        consecutiveStressSteps: 2,
        consecutiveNormalizationSteps: 0,
        lastEntryAsOf: '2025-01-01'
      },
      'test-insurance',
      'roll-forward'
    );

    const res = await planInsuranceSleeve(
      buildStressInput('roll-forward', '2025-01-15', {
        optionPositions: [
          {
            underlying: 'SPY',
            optionSymbol: 'SPY:PUT:95:2025-01-22',
            type: 'PUT',
            strike: 95,
            expiry: '2025-01-22',
            contracts: 2,
            multiplier: 100,
            avgOpenPrice: 5.5,
            openDate: '2025-01-01',
            marketPrice: 4.8,
            marketValueUsd: 960,
            unrealizedPnlUsd: -140
          }
        ],
        optionMarks: [
          {
            positionId: 'SPY:PUT:95:2025-01-22',
            underlying: 'SPY',
            type: 'PUT',
            strike: 95,
            expiry: '2025-01-22',
            daysToExpiry: 7,
            marketPrice: 4.8,
            marketValueUsd: 960,
            estimatedMark: 4.8
          }
        ]
      })
    );

    expect(res.plannedAction).toBe('ROLL');
    expect(res.order).toBeTruthy();
    expect(res.rollOrder).toBeTruthy();
    expect(res.flags.some((flag) => flag.code === 'INSURANCE_ROLL_PLANNED')).toBe(true);
  });

  it('fails gracefully when budget is too small for one staged tranche', async () => {
    resetState('test-insurance', 'tiny-budget');
    const res = await planInsuranceSleeve(
      buildStressInput('tiny-budget', '2025-01-01', {
        dislocationState: {
          active: true,
          phase: 'ADD',
          currentTier: 3,
          triggeredAtISO: '2025-01-01T16:00:00.000Z'
        },
        reserveBudget: 10,
        reservePoolUsd: 10,
        cashAvailable: 10
      })
    );

    expect(res.plannedAction).toBe('NONE');
    expect(res.reason).toBe('Budget insufficient for 1 contract');
  });
});

describe('contract selection', () => {
  it('returns synthetic contract without chain', async () => {
    const contract = await selectInsuranceContract('SPY', '2025-01-01', 100, baseConfig);
    expect(contract).toBeTruthy();
    expect(contract?.type).toBe('PUT');
  });
});
