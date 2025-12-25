import fs from 'fs';
import path from 'path';
import { computeMacroLagFlags, buildRound2FromFeatures, buildRound1FromInputs } from '../src/cli/contextBuilder';
import { MacroSeries, RunInputs, BotConfig, SymbolFeature } from '../src/core/types';

const runsDir = path.resolve(process.cwd(), 'runs');

const cleanup = (runId: string) => {
  const dir = path.join(runsDir, runId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
};

const makeMacro = (id: string, asOf: string, lagDays: number): MacroSeries => {
  const d = new Date(asOf);
  d.setDate(d.getDate() - lagDays);
  const date = d.toISOString().slice(0, 10);
  return { id, points: [{ date, value: 1 }] };
};

const makeConfig = (over?: Partial<BotConfig>): BotConfig => {
  const base = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/config/default.json'), 'utf-8')) as BotConfig;
  return { ...base, ...over };
};

describe('Macro lag policy', () => {
  test('flags_warn policy emits MACRO_LAGGED', () => {
    const asOf = '2025-12-31';
    const macro = [makeMacro('CPIAUCSL', asOf, 52), makeMacro('UNRATE', asOf, 52)];
    const cfg = makeConfig({ round0MacroLagPolicy: 'flags_warn', macroLagWarnDays: 45 });
    const res = computeMacroLagFlags(asOf, macro, cfg.round0MacroLagPolicy!, cfg.macroLagWarnDays!, cfg.macroLagErrorDays);
    expect(res.flags.some((f) => f.code === 'MACRO_LAGGED')).toBe(true);
    expect(res.macroLagDays.CPIAUCSL).toBeDefined();
    expect(res.macroLatest.CPIAUCSL).toBeDefined();
  });

  test('summary_only policy omits MACRO_LAGGED but Round2 emits MACRO_LAG_IMPACTING_CONFIDENCE', async () => {
    const runId = 'macro-summary-only';
    cleanup(runId);
    const asOf = '2025-12-31';
    const macro = [makeMacro('CPIAUCSL', asOf, 52)];
    const config = makeConfig({ round0MacroLagPolicy: 'summary_only', macroLagWarnDays: 45 });
    const universe = ['SPY'];
    const history = {
      SPY: Array.from({ length: 60 }).map((_, i) => {
        const d = new Date(asOf);
        d.setDate(d.getDate() - i);
        return { date: d.toISOString().slice(0, 10), close: 100 + i };
      })
    };
    const inputs: RunInputs = {
      asOf,
      config,
      universe,
      portfolio: { cash: 250, equity: 250, holdings: [] },
      quotes: { SPY: 160 },
      history,
      macro
    };
    const dir = path.join(runsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify(inputs, null, 2));
    // Need features for round2; build via round1 helper
    fs.writeFileSync(path.join(dir, 'round0_flags.json'), JSON.stringify([], null, 2));
    await buildRound1FromInputs(runId);
    fs.writeFileSync(path.join(dir, 'round1_flags.json'), JSON.stringify([], null, 2));
    await buildRound2FromFeatures(runId);
    const round2Flags = JSON.parse(fs.readFileSync(path.join(dir, 'round2_flags.json'), 'utf-8'));
    expect(round2Flags.some((f: any) => f.code === 'MACRO_LAG_IMPACTING_CONFIDENCE')).toBe(true);
    cleanup(runId);
  });

  test('Warn flags are not filtered out', () => {
    const asOf = '2025-12-31';
    const macro = [makeMacro('CPIAUCSL', asOf, 52)];
    const res = computeMacroLagFlags(asOf, macro, 'flags_warn', 45);
    const warnFlags = res.flags.filter((f) => f.severity === 'warn');
    expect(warnFlags.length).toBeGreaterThan(0);
  });
});
