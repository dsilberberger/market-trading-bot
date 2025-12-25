import fs from 'fs';
import path from 'path';
import { buildRound1FromInputs, buildRound2FromFeatures } from '../src/cli/contextBuilder';
import { RunInputs, BotConfig } from '../src/core/types';

const runsDir = path.resolve(process.cwd(), 'runs');

const writeInputs = (runId: string, inputs: RunInputs) => {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify(inputs, null, 2));
};

const makeConfig = (): BotConfig =>
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/config/default.json'), 'utf-8'));

const genHistory = (asOf: string, slope: number, bars: number, intervalDays = 1) => {
  const arr: { date: string; close: number }[] = [];
  const base = 100;
  for (let i = bars - 1; i >= 0; i--) {
    const d = new Date(asOf);
    d.setDate(d.getDate() - i * intervalDays);
    arr.push({ date: d.toISOString().slice(0, 10), close: base + slope * (bars - 1 - i) });
  }
  return arr;
};

describe('Round 1 buckets and samples', () => {
  const cleanup = (runId: string) => {
    const dir = path.join(runsDir, runId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  };

  test('Bucket mapping at boundaries and sample fields', async () => {
    const runId = 'test-buckets-boundary';
    cleanup(runId);
    const asOf = '2025-12-31';
    const universe = ['A', 'B', 'C', 'D'];
    const history: Record<string, any[]> = {
      A: genHistory(asOf, 0.1, 61),
      B: genHistory(asOf, 0.2, 61),
      C: genHistory(asOf, 0.3, 61),
      D: genHistory(asOf, 0.4, 61)
    };
    const quotes = Object.fromEntries(universe.map((s) => [s, history[s][history[s].length - 1].close]));
    const inputs: RunInputs = {
      asOf,
      config: makeConfig(),
      universe,
      portfolio: { cash: 250, equity: 250, holdings: [] },
      quotes,
      history,
      macro: []
    };
    writeInputs(runId, inputs);
    await buildRound1FromInputs(runId);
    const features = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'features.json'), 'utf-8'));
    const buckets = Object.fromEntries(features.map((f: any) => [f.symbol, f.return60dPctileBucket]));
    expect(buckets.A).toBe('low');
    expect(buckets.B).toBe('mid');
    expect(buckets.C).toBe('high'); // 0.66... buckets to high per >0.66 rule
    expect(buckets.D).toBe('high');
    features.forEach((f: any) => {
      expect(f.historySamples).toBe(61);
      expect(f.historyUniqueCloses).toBe(61);
    });
  });

  test('Unreliable percentiles emit warning and set unknown buckets', async () => {
    const runId = 'test-buckets-unknown';
    cleanup(runId);
    const asOf = '2025-12-31';
    const universe = ['A'];
    const history: Record<string, any[]> = { A: genHistory(asOf, 0, 5) }; // single symbol, tiny sample
    const quotes = { A: history.A[history.A.length - 1].close };
    const inputs: RunInputs = {
      asOf,
      config: makeConfig(),
      universe,
      portfolio: { cash: 250, equity: 250, holdings: [] },
      quotes,
      history,
      macro: []
    };
    writeInputs(runId, inputs);
    await buildRound1FromInputs(runId);
    const features = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'features.json'), 'utf-8'));
    const flags = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'round1_flags.json'), 'utf-8'));
    expect(features[0].return60dPctileBucket).toBe('unknown');
    expect(features[0].vol20dPctileBucket).toBe('unknown');
    expect(flags.some((f: any) => f.code === 'PERCENTILE_UNRELIABLE')).toBe(true);
  });

  test('Round 2 can consume bucketed features', async () => {
    const runId = 'test-round2-buckets';
    cleanup(runId);
    const asOf = '2025-12-31';
    const universe = ['A', 'B', 'C', 'D'];
    const history: Record<string, any[]> = {
      A: genHistory(asOf, 0.1, 61),
      B: genHistory(asOf, 0.2, 61),
      C: genHistory(asOf, 0.3, 61),
      D: genHistory(asOf, 0.4, 61)
    };
    const quotes = Object.fromEntries(universe.map((s) => [s, history[s][history[s].length - 1].close]));
    const inputs: RunInputs = {
      asOf,
      config: makeConfig(),
      universe,
      portfolio: { cash: 250, equity: 250, holdings: [] },
      quotes,
      history,
      macro: []
    };
    writeInputs(runId, inputs);
    await buildRound1FromInputs(runId);
    await buildRound2FromFeatures(runId);
    const regimes = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'regimes.json'), 'utf-8'));
    expect(regimes).toBeTruthy();
    expect(regimes.equityRegime).toBeDefined();
  });
});
