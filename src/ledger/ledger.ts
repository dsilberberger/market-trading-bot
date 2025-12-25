import crypto from 'crypto';
import { LedgerEvent, LedgerEventType } from '../core/types';
import { appendLedgerEvent, readEventsForRun, readLedgerEvents } from './storage';

const safeUuid = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const makeEvent = (runId: string, type: LedgerEventType, details?: Record<string, unknown>): LedgerEvent => ({
  id: safeUuid(),
  runId,
  timestamp: new Date().toISOString(),
  type,
  details
});

export const appendEvent = (event: LedgerEvent) => {
  appendLedgerEvent(event);
};

export type RunStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'UNKNOWN';

export const getRunStatus = (runId: string): RunStatus => {
  const events = readEventsForRun(runId);
  if (!events.length) return 'UNKNOWN';
  const last = events
    .slice()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .at(-1);
  if (!last) return 'UNKNOWN';
  switch (last.type) {
    case 'RUN_COMPLETED':
      return 'COMPLETED';
    case 'RUN_REJECTED':
      return 'REJECTED';
    case 'RUN_FAILED':
      return 'FAILED';
    case 'RUN_APPROVED':
      return 'APPROVED';
    case 'RUN_PENDING_APPROVAL':
      return 'PENDING_APPROVAL';
    case 'RUN_STARTED':
      return 'IN_PROGRESS';
    default:
      return 'UNKNOWN';
  }
};

export const getRecentRuns = (limit = 10): { runId: string; status: RunStatus }[] => {
  const events = readLedgerEvents();
  const seen = new Map<string, { status: RunStatus; ts: number }>();
  for (const evt of events) {
    const ts = new Date(evt.timestamp).getTime();
    const status = getRunStatus(evt.runId);
    const existing = seen.get(evt.runId);
    if (!existing || ts > existing.ts) {
      seen.set(evt.runId, { status, ts });
    }
  }
  return Array.from(seen.entries())
    .sort(([, a], [, b]) => b.ts - a.ts)
    .slice(0, limit)
    .map(([runId, info]) => ({ runId, status: info.status }));
};

export const groupEventsByRun = (): Record<string, LedgerEvent[]> => {
  const events = readLedgerEvents();
  return events.reduce<Record<string, LedgerEvent[]>>((acc, evt) => {
    acc[evt.runId] = acc[evt.runId] || [];
    acc[evt.runId].push(evt);
    return acc;
  }, {});
};

export const getEvents = () => readLedgerEvents();
export const getEventsForRun = readEventsForRun;
