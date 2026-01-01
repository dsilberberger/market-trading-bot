import { BotConfig, LedgerEvent } from '../core/types';
import { RunStatus, getRunStatus, getEvents } from '../ledger/ledger';
import { getCurrentRebalanceWindow, getRebalanceKey, isRebalanceDay } from '../core/time';

export interface ApprovalEligibility {
  eligible: boolean;
  reasons: string[];
  alreadyExecutedRunId?: string;
  rebalanceKey: string;
  isRebalanceDay: boolean;
  window: { startISO: string; endISO: string };
}

interface EligibilityOptions {
  now?: Date;
  events?: LedgerEvent[];
  runStatus?: RunStatus;
}

const reasonTexts: Record<string, string> = {
  NOT_REBALANCE_DAY: 'Today is not the configured rebalance day.',
  ALREADY_EXECUTED_THIS_WINDOW: 'A proposal already executed in this rebalance window.',
  RUN_ALREADY_EXECUTED: 'This run already executed.',
  UNKNOWN: 'Ineligible for unknown reason.'
};

const reasonText = (code: string) => reasonTexts[code] || code;

export const describeReasons = (codes: string[]): string[] => codes.map((c) => reasonText(c));

export const computeApprovalEligibility = (
  runId: string,
  cfg: BotConfig,
  opts: EligibilityOptions = {}
): ApprovalEligibility => {
  const now = opts.now ?? new Date();
  const events = opts.events ?? getEvents();
  const status = opts.runStatus ?? getRunStatus(runId);
  const rebalanceDay = cfg.rebalanceDay || 'WEDNESDAY';
  const window = getCurrentRebalanceWindow(now, rebalanceDay);
  const reasons: string[] = [];

  const isDay = isRebalanceDay(now, rebalanceDay);
  if (!isDay) reasons.push('NOT_REBALANCE_DAY');

  if (status === 'COMPLETED') {
    reasons.push('RUN_ALREADY_EXECUTED');
  }

  let alreadyExecutedRunId: string | undefined;
  const executed = events.find((evt) => {
    if (evt.type !== 'EXECUTION_SENT_TO_BROKER') return false;
    const evtKey =
      (evt.details?.rebalanceKey as string) || getRebalanceKey(new Date(evt.timestamp), rebalanceDay);
    const tsIso = new Date(evt.timestamp).toISOString();
    const inWindow = tsIso >= window.startISO && tsIso < window.endISO;
    if (evtKey === window.key || inWindow) {
      alreadyExecutedRunId = evt.runId;
      return true;
    }
    return false;
  });
  if (executed && alreadyExecutedRunId !== runId) {
    reasons.push('ALREADY_EXECUTED_THIS_WINDOW');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    alreadyExecutedRunId,
    rebalanceKey: window.key,
    isRebalanceDay: isDay,
    window: { startISO: window.startISO, endISO: window.endISO }
  };
};
