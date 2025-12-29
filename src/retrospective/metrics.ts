import fs from 'fs';
import path from 'path';

export interface Round6Metrics {
  turnoverNotionalUSD: number;
  trades: number;
  invalidationsBreached: boolean;
  notes: string[];
}

export const computeRound6Metrics = (runId: string, baseDir = process.cwd()): Round6Metrics => {
  const runDir = path.join(baseDir, 'runs', runId);
  const ordersPath = path.join(runDir, 'orders.json');
  let turnover = 0;
  let trades = 0;
  if (fs.existsSync(ordersPath)) {
    try {
      const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
      if (Array.isArray(orders)) {
        trades = orders.length;
        turnover = orders.reduce((acc, o) => acc + (o.notionalUSD || 0), 0);
      }
    } catch {
      // ignore
    }
  }
  const metrics: Round6Metrics = {
    turnoverNotionalUSD: turnover,
    trades,
    invalidationsBreached: false,
    notes: []
  };
  return metrics;
};

export const writeRound6Metrics = (runId: string, baseDir = process.cwd()) => {
  const runDir = path.join(baseDir, 'runs', runId);
  const metrics = computeRound6Metrics(runId, baseDir);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'round6_metrics.json'), JSON.stringify(metrics, null, 2));
  return metrics;
};

// Backward-compatible alias
export const generateRound6Metrics = writeRound6Metrics;
