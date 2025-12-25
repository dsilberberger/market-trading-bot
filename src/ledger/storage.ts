import fs from 'fs';
import path from 'path';
import { ensureDir, writeJSONFile } from '../core/utils';
import { LedgerEvent } from '../core/types';

const configuredPath = process.env.LEDGER_FILE ? path.resolve(process.env.LEDGER_FILE) : undefined;
const ledgerFile = configuredPath ?? path.join(path.resolve(process.cwd(), 'ledger'), 'events.jsonl');
const ledgerDir = path.dirname(ledgerFile);

export const getLedgerFile = () => ledgerFile;

export const appendLedgerEvent = (event: LedgerEvent) => {
  ensureDir(ledgerDir);
  const line = JSON.stringify(event);
  fs.appendFileSync(ledgerFile, `${line}\n`);
};

export const readLedgerEvents = (): LedgerEvent[] => {
  if (!fs.existsSync(ledgerFile)) return [];
  const content = fs.readFileSync(ledgerFile, 'utf-8');
  const lines = content.trim().length ? content.trim().split('\n') : [];
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch (err) {
        return undefined;
      }
    })
    .filter((v): v is LedgerEvent => Boolean(v));
};

export const readEventsForRun = (runId: string): LedgerEvent[] => {
  return readLedgerEvents().filter((e) => e.runId === runId);
};

export const writeRunArtifact = (runId: string, fileName: string, data: unknown) => {
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  ensureDir(runDir);
  const filePath = path.join(runDir, fileName);
  writeJSONFile(filePath, data);
};

export const readRunArtifact = <T>(runId: string, fileName: string): T | undefined => {
  const runDir = path.resolve(process.cwd(), 'runs', runId);
  const filePath = path.join(runDir, fileName);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
};
