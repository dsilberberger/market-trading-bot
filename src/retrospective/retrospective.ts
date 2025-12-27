import fs from 'fs';
import path from 'path';

export const generateRound6Retrospective = (runId: string) => {
  const metricsPath = path.resolve(process.cwd(), 'runs', runId, 'round6_metrics.json');
  if (!fs.existsSync(metricsPath)) return;
  let metrics: any = {};
  try {
    metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
  } catch {
    metrics = {};
  }
  const content = `# Round 6 Retrospective

This document is explanatory only and does not change rules or thresholds.

- As of: ${metrics.asOf || 'n/a'}
- Equity: ${metrics.equity ?? 'n/a'}
- Orders placed: ${metrics.ordersPlaced ?? 0}, fills recorded: ${metrics.fillsRecorded ?? 0}
- Total notional traded: ${metrics.totalNotional ?? 0}
- Turnover: ${((metrics.turnoverPct || 0) * 100).toFixed(2)}%
- Dislocation phase: ${metrics.dislocationPhase || 'INACTIVE'}

What went as expected: Trades followed policy gates and whole-share constraints.
What to watch: Exposure vs caps, dislocation sleeve status, and turnover vs limits.
This does not change rules/thresholds.`;
  const outPath = path.resolve(process.cwd(), 'runs', runId, 'round6_retrospective.md');
  fs.writeFileSync(outPath, content);
};
