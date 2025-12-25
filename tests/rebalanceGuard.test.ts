import { computeApprovalEligibility } from '../src/ui/approval';
import { getRebalanceKey, isRebalanceDay } from '../src/core/time';
import { BotConfig, LedgerEvent } from '../src/core/types';

const baseConfig: BotConfig = {
  startingCapitalUSD: 250,
  maxPositions: 4,
  rebalanceDay: 'TUESDAY',
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
  universeFile: '',
  baselinesEnabled: true,
  slippageBps: 5,
  commissionPerTradeUSD: 0,
  useLLM: true,
  requireApproval: true,
  uiPort: 8787,
  uiBind: '127.0.0.1'
};

describe('rebalance helpers', () => {
  it('detects rebalance day for America/Los_Angeles', () => {
    const tuesday = new Date('2025-12-23T18:00:00Z'); // Tuesday UTC
    expect(isRebalanceDay(tuesday, 'TUESDAY')).toBe(true);
    const monday = new Date('2025-12-22T18:00:00Z');
    expect(isRebalanceDay(monday, 'TUESDAY')).toBe(false);
  });

  it('blocks approval when not rebalance day', () => {
    const monday = new Date('2025-12-22T12:00:00Z');
    const eligibility = computeApprovalEligibility('2025-12-22', baseConfig, {
      now: monday,
      events: [],
      runStatus: 'PENDING_APPROVAL'
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContain('NOT_REBALANCE_DAY');
  });

  it('blocks when already executed in the same window', () => {
    const now = new Date('2025-12-23T12:00:00Z'); // Tuesday
    const execEvent: LedgerEvent = {
      id: 'evt-1',
      runId: 'prior-run',
      timestamp: '2025-12-23T08:00:00Z',
      type: 'EXECUTION_SENT_TO_BROKER',
      details: { rebalanceKey: getRebalanceKey(now, 'TUESDAY') }
    };
    const eligibility = computeApprovalEligibility('2025-12-23', baseConfig, {
      now,
      events: [execEvent],
      runStatus: 'PENDING_APPROVAL'
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContain('ALREADY_EXECUTED_THIS_WINDOW');
    expect(eligibility.alreadyExecutedRunId).toBe('prior-run');
  });

  it('allows approval when on rebalance day with no prior execution', () => {
    const now = new Date('2025-12-23T12:00:00Z');
    const eligibility = computeApprovalEligibility('2025-12-23', baseConfig, {
      now,
      events: [],
      runStatus: 'PENDING_APPROVAL'
    });
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.reasons.length).toBe(0);
  });
});
