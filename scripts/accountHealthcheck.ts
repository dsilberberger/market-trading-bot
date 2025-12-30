/* eslint-disable no-console */
import { performance } from 'perf_hooks';

type SubCheck = { ok: boolean; errors: string[] } & Record<string, any>;

export interface AccountHealth {
  ok: boolean;
  timestamp: string;
  latencyMs: number;
  accountIdRedacted?: string;
  balancesCheck: SubCheck;
  positionsCheck: SubCheck;
  ordersCheck: SubCheck;
  transactionsCheck: SubCheck;
  flagsCheck: SubCheck;
  accountNavReconciliation?: { computedNAV?: number; reportedNAV?: number; diff?: number; ok: boolean; notes: string };
}

// Harness stub: replace with real E*TRADE account calls when available.
export const accountApiHealthcheck = async (): Promise<AccountHealth> => {
  const start = performance.now();
  const now = new Date().toISOString();
  const balancesCheck: SubCheck = { ok: true, errors: [], cash: 2000, totalEquity: 2000, marketValue: 0 };
  const positionsSample: Array<{ symbol: string; quantity: number }> = [];
  const positionsCheck: SubCheck = { ok: true, errors: [], count: positionsSample.length, positionsSample };
  const ordersCheck: SubCheck = { ok: true, errors: [], openOrdersCount: 0 };
  const transactionsCheck: SubCheck = { ok: true, errors: [], mostRecentFillTime: null };
  const flagsCheck: SubCheck = { ok: true, errors: [], accountType: 'CASH', pdt: false };
  const ok = balancesCheck.ok && positionsCheck.ok;
  return {
    ok,
    timestamp: now,
    latencyMs: performance.now() - start,
    accountIdRedacted: '****',
    balancesCheck,
    positionsCheck,
    ordersCheck,
    transactionsCheck,
    flagsCheck,
    accountNavReconciliation: { ok: false, notes: 'reconciliation skipped: no positions in account' }
  };
};

if (require.main === module) {
  accountApiHealthcheck().then((res) => console.log(JSON.stringify(res, null, 2)));
}
