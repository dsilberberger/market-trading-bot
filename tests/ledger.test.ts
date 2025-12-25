import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpLedger = path.join(os.tmpdir(), 'ledger-test-events.jsonl');

const loadLedger = () => {
  jest.resetModules();
  process.env.LEDGER_FILE = tmpLedger;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/ledger/ledger') as typeof import('../src/ledger/ledger');
};

describe('Ledger and approval transitions', () => {
  beforeEach(() => {
    if (fs.existsSync(tmpLedger)) fs.unlinkSync(tmpLedger);
  });

  it('tracks approval lifecycle', () => {
    const { appendEvent, makeEvent, getRunStatus } = loadLedger();
    const runId = '2025-12-20';
    appendEvent(makeEvent(runId, 'RUN_STARTED'));
    appendEvent(makeEvent(runId, 'RUN_PENDING_APPROVAL'));
    expect(getRunStatus(runId)).toBe('PENDING_APPROVAL');
    appendEvent(makeEvent(runId, 'RUN_APPROVED'));
    expect(getRunStatus(runId)).toBe('APPROVED');
    appendEvent(makeEvent(runId, 'RUN_COMPLETED'));
    expect(getRunStatus(runId)).toBe('COMPLETED');
  });
});
