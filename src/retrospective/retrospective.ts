import fs from 'fs';
import path from 'path';
import { computeRound6Metrics, writeRound6Metrics } from './metrics';
import { mdSection, defaultFooter } from '../narratives/templates';

export const writeRound6Retrospective = (runId: string, baseDir = process.cwd()) => {
  const runDir = path.join(baseDir, 'runs', runId);
  const metricsPath = path.join(runDir, 'round6_metrics.json');
  const metrics = fs.existsSync(metricsPath)
    ? (JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as ReturnType<typeof computeRound6Metrics>)
    : writeRound6Metrics(runId, baseDir);

  const lines = [
    `Trades: ${metrics.trades}`,
    `Turnover (USD): ${metrics.turnoverNotionalUSD.toFixed(2)}`,
    `Invalidations breached: ${metrics.invalidationsBreached}`,
    metrics.notes.length ? 'Notes:\n' + metrics.notes.join('\n') : 'Notes: none'
  ].join('\n');

  const content = mdSection('Round 6 Retrospective', lines) + defaultFooter();
  const outPath = path.join(runDir, 'round6_retrospective.md');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(outPath, content);
  return { metrics, path: outPath };
};

// Backward-compatible alias
export const generateRound6Retrospective = writeRound6Retrospective;
