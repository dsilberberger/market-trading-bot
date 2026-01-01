import fs from 'fs';
import path from 'path';
import { mdSection, bulletList, defaultFooter, safeLoadJson } from './templates';
import { computeRound6Metrics } from '../retrospective/metrics';

const write = (p: string, content: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

const ensure = (runDir: string, file: string) => path.join(runDir, file);

const round0Explanation = (runDir: string) => {
  const inputs = safeLoadJson<any>(ensure(runDir, 'inputs.json'));
  const dataSources = safeLoadJson<any>(ensure(runDir, 'data_sources.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round0_flags.json')) || [];

  const providers = dataSources?.providers || {};
  const asOf = inputs?.asOf || dataSources?.asOf || 'n/a';

  // Coverage: infer from first history series if present
  const history = inputs?.history || {};
  const firstSym = Object.keys(history)[0];
  const samples = Array.isArray(history[firstSym]) ? history[firstSym].length : 0;
  let cadence = 'n/a';
  if (samples >= 2 && Array.isArray(history[firstSym])) {
    const bars = history[firstSym];
    const last = new Date(bars[bars.length - 1].date);
    const prev = new Date(bars[bars.length - 2].date);
    const diffDays = Math.abs((last.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
    cadence = diffDays >= 5 ? 'weekly' : 'daily';
  }

  const macroIds =
    Array.isArray(inputs?.macro) && inputs.macro.length
      ? inputs.macro.map((m: any) => m.id || m.name || 'macro').filter(Boolean).join(', ')
      : 'n/a';

  const qualityNotes = flags.length
    ? flags.map((f) => `${f.code || 'FLAG'}: ${f.message || ''}`.trim())
    : ['None observed'];

  const impact =
    flags.length > 0
      ? '- Regime or confidence may be dampened; warnings only applied.\n- No hard blocks; continue with caution.'
      : '- No expected impact; data deemed sufficient for later rounds.';

  return [
    '# Round 0 — Data Intake & Integrity',
    '',
    '## What data was loaded',
    `- Market data provider: ${providers.marketDataProvider || 'n/a'}`,
    `- Macro data provider: ${providers.macroProvider || 'n/a'}`,
    `- News provider: ${providers.newsProvider || 'n/a'}`,
    `- As-of timestamp: ${asOf}`,
    '',
    '## Data coverage',
    `- Equity price history: ${cadence} bars (${samples} samples)`,
    `- Macro series: ${macroIds}`,
    '',
    '## Data quality notes',
    bulletList(qualityNotes),
    '## Impact on later decisions',
    impact,
    ''
  ].join('\n');
};

const round0Summary = (runDir: string) => round0Explanation(runDir);

const round1Summary = (runDir: string) => {
  const feats = safeLoadJson<any[]>(ensure(runDir, 'features.json')) || [];
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round1_flags.json')) || [];
  const bySymbol = feats.reduce<Record<string, any>>((acc, f) => {
    acc[f.symbol] = f;
    return acc;
  }, {});

  const observations: string[] = [];
  const addObs = (sym: string, fn: (f: any) => string | null) => {
    const f = bySymbol[sym];
    if (!f) return;
    const obs = fn(f);
    if (obs) observations.push(`${sym}: ${obs}`);
  };

  addObs('SPY', (f) => {
    const trend = f.ma50 && f.ma200 ? (f.ma50 > f.ma200 ? 'Uptrend' : 'Downtrend') : null;
    const vol = f.vol20dPctile !== null && f.vol20dPctile !== undefined ? `vol pctile ${f.vol20dPctile}` : null;
    const ret = f.return60dPctile !== null && f.return60dPctile !== undefined ? `return pctile ${f.return60dPctile}` : null;
    return [trend, vol, ret].filter(Boolean).join(', ') || null;
  });
  addObs('QQQ', (f) => {
    const trend = f.ma50 && f.ma200 ? (f.ma50 > f.ma200 ? 'Uptrend' : 'Downtrend') : null;
    const vol = f.vol20dPctile !== null && f.vol20dPctile !== undefined ? `vol pctile ${f.vol20dPctile}` : null;
    const ret = f.return60dPctile !== null && f.return60dPctile !== undefined ? `return pctile ${f.return60dPctile}` : null;
    return [trend, vol, ret].filter(Boolean).join(', ') || null;
  });
  addObs('IWM', (f) => {
    const ret20 = f.return20d !== undefined ? `20d return ${(f.return20d * 100).toFixed(1)}%` : null;
    const vol = f.vol20d !== undefined ? `vol20d ${(f.vol20d * 100).toFixed(1)}%` : null;
    return [ret20, vol].filter(Boolean).join(', ') || null;
  });

  const summary: string[] = [];
  summary.push('# Round 1 — Feature Engineering');
  summary.push('');
  summary.push('## What was computed');
  summary.push('- Returns: 5d, 20d, 60d (weekly)');
  summary.push('- Volatility: 20d realized');
  summary.push('- Drawdowns: 60d peak-to-trough');
  summary.push('- Trend indicators: 50/200 DMA relationships');
  summary.push('');
  summary.push('## Notable observations');
  summary.push(observations.length ? bulletList(observations) : '_None_');
  summary.push('');
  summary.push('## Data limitations');
  summary.push('- Percentile rankings are coarse due to limited history');
  summary.push('');
  return summary.join('\n');
};

const round2Summary = (runDir: string) => {
  const regimes = safeLoadJson<any>(ensure(runDir, 'regimes.json'));
  const eligibility = safeLoadJson<any>(ensure(runDir, 'eligibility.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round2_flags.json')) || [];
  const macro = safeLoadJson<any>(ensure(runDir, 'macro_policy.json'));

  const eq = regimes?.equityRegime;
  const vol = regimes?.volRegime;
  const rates = regimes?.ratesRegime;
  const inflationTrend = macro?.inflation?.trend3;

  const summary: string[] = [];
  summary.push('# Round 2 — Market Regime Assessment');
  summary.push('');
  summary.push('## Detected regimes');
  summary.push(
    bulletList([
      eq ? `Equity regime: ${eq.label || 'n/a'} (confidence: ${eq.confidence ?? 'n/a'})` : 'Equity regime: n/a',
      vol ? `Volatility regime: ${vol.label || 'n/a'}` : 'Volatility regime: n/a',
      rates ? `Rates regime: ${rates.label || 'n/a'}${rates.stance ? `, ${rates.stance}` : ''}` : 'Rates regime: n/a',
      inflationTrend !== undefined ? `Inflation trend: ${inflationTrend >= 0 ? 'Up' : 'Down'}` : 'Inflation trend: n/a'
    ])
  );
  summary.push('');
  summary.push('## Why the equity regime is as classified');
  summary.push(
    bulletList([
      'Momentum mix across indices (SPY/QQQ/IWM) considered.',
      vol ? (vol.label === 'low' ? 'Low volatility supports risk-on behavior.' : 'Elevated volatility dampens risk-on.') : 'Volatility context unavailable.',
      'Trend signals across assets influence regime confidence.'
    ])
  );
  summary.push('');
  summary.push('## Confidence and risks');
  summary.push(
    bulletList([
      eq ? `Equity regime confidence: ${eq.confidence ?? 'n/a'}` : 'Equity regime confidence: n/a',
      eq?.transitionRisk ? `Transition risk: ${eq.transitionRisk}` : 'Transition risk: n/a',
      flags.length ? `Flags present: ${flags.map((f) => f.code).join(', ')}` : 'No blocking flags.'
    ])
  );
  summary.push('');
  return summary.join('\n');
};

const round3Summary = (runDir: string) => {
  const eligibility = safeLoadJson<any>(ensure(runDir, 'eligibility.json')) || {};
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round3_flags.json')) || [];
  const capital = safeLoadJson<any>(ensure(runDir, 'capitalPools.json')) || {};
  const inputs = safeLoadJson<any>(ensure(runDir, 'inputs.json')) || {};
  const budgets = safeLoadJson<any>(ensure(runDir, 'capital_budgets.json')) || {};

  const nav = inputs?.portfolio?.equity ?? budgets?.nav ?? capital?.navUsd ?? 'n/a';
  const core = capital?.corePoolUsd ?? budgets?.coreBudget ?? 'n/a';
  const reserve = capital?.reservePoolUsd ?? budgets?.reserveBudget ?? 'n/a';
  const maxPosPct = inputs?.config?.maxPositionPct ?? 0.35;
  const maxPosUsd = typeof nav === 'number' ? nav * maxPosPct : 'n/a';

  const proxies: string[] = [];
  Object.entries(eligibility || {}).forEach(([sym, e]: any) => {
    if (e?.proxyChosen) proxies.push(`${sym} → ${e.proxyChosen}`);
  });

  const tradable: string[] = [];
  const blocked: string[] = [];
  Object.entries(eligibility || {}).forEach(([sym, e]: any) => {
    if (e?.tradable) tradable.push(sym);
    else blocked.push(`${sym}: ${e?.reason || 'not tradable'}`);
  });

  const summary: string[] = [];
  summary.push('# Round 3 — Trade Eligibility & Constraints');
  summary.push('');
  summary.push('## Capital constraints');
  summary.push(
    bulletList([
      `Account NAV: ${typeof nav === 'number' ? `$${nav.toFixed(2)}` : 'n/a'}`,
      `Core allocation (70%): ${typeof core === 'number' ? `$${core.toFixed(2)}` : 'n/a'}`,
      `Reserve allocation (30%): ${typeof reserve === 'number' ? `$${reserve.toFixed(2)}` : 'n/a'}`,
      `Max position size: ${typeof maxPosUsd === 'number' ? `$${maxPosUsd.toFixed(2)}` : 'n/a'} (${(maxPosPct * 100).toFixed(0)}% of NAV)`
    ])
  );
  summary.push('');
  summary.push('## Eligibility results');
  summary.push(
    bulletList([
      tradable.length ? `Tradable: ${tradable.join(', ')}` : 'Tradable: none',
      blocked.length ? `Not tradable: ${blocked.join('; ')}` : 'Not tradable: none',
      proxies.length ? `Proxies selected:\n${proxies.map((p) => `  - ${p}`).join('\n')}` : 'Proxies selected: none'
    ])
  );
  summary.push('');
  summary.push('## Execution constraints');
  summary.push(
    bulletList([
      'Whole-share execution only (E*TRADE)',
      'Minimum viable position enforced',
      'Proxy use when primary symbol unaffordable'
    ])
  );
  if (flags.length) {
    summary.push('');
    summary.push('## Flags');
    summary.push(bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  }
  summary.push('');
  return summary.join('\n');
};

const round4Summary = (runDir: string) => {
  const execPlan = safeLoadJson<any>(ensure(runDir, 'execution_plan.json'));
  const substitutions = safeLoadJson<any[]>(ensure(runDir, 'execution_substitutions.json')) || [];
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round4_flags.json')) || [];

  const intended = execPlan?.targets || execPlan?.orders || [];
  const orders = execPlan?.orders || [];
  const remainingCash = execPlan?.remainingCashUSD ?? execPlan?.remainingCash ?? null;

  const summary: string[] = [];
  summary.push('# Round 4 — Portfolio Planning');
  summary.push('');
  summary.push('## Intended allocation');
  if (intended.length) {
    summary.push(
      bulletList(
        intended.map((t: any) => {
          const sym = t.symbol || t.originalSymbol || 'n/a';
          const notional = t.notionalUSD ?? t.estNotionalUSD;
          const weight = t.targetWeight ?? t.weight;
          const parts = [];
          parts.push(`Symbol: ${sym}`);
          if (weight !== undefined) parts.push(`Weight: ${(weight * 100).toFixed(1)}%`);
          if (notional !== undefined) parts.push(`Notional: $${Number(notional).toFixed(0)}`);
          return parts.join(', ');
        })
      )
    );
  } else {
    summary.push('_None_');
  }

  summary.push('');
  summary.push('## Adjustments made');
  summary.push(
    substitutions.length
      ? bulletList(
          substitutions.map((s: any) => `${s.originalSymbol || 'n/a'} substituted with ${s.executedSymbol || 'n/a'} (${s.reason || ''})`)
        )
      : '_None_'
  );

  summary.push('');
  summary.push('## Planned positions');
  summary.push(
    orders.length
      ? bulletList(
          orders.map((o: any) => {
            const qty = o.quantity ?? o.estQuantity ?? 'n/a';
            const notional = o.estNotionalUSD ?? o.notionalUSD;
            return `${o.symbol || 'n/a'}: ${qty} shares${notional !== undefined ? ` (~$${Number(notional).toFixed(0)})` : ''}`;
          })
        )
      : '_None_'
  );

  summary.push('');
  summary.push('## Remaining core cash');
  summary.push(remainingCash !== null && remainingCash !== undefined ? `- ~$${Number(remainingCash).toFixed(0)}` : '- n/a');

  if (flags.length) {
    summary.push('');
    summary.push('## Flags');
    summary.push(bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  }

  summary.push('');
  return summary.join('\n');
};

const round5Summary = (runDir: string) => {
  const proposal = safeLoadJson<any>(ensure(runDir, 'proposal.json'));
  const risk = safeLoadJson<any>(ensure(runDir, 'risk_report.json'));
  const execPlan = safeLoadJson<any>(ensure(runDir, 'execution_plan.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round5_flags.json')) || [];
  const lines: string[] = [];
  const orders = proposal?.intent?.orders || [];
  const equityConf = (proposal as any)?.regimes?.equityRegime?.confidence ?? 'n/a';
  const maxPosPct = proposal?.intent?.orders?.[0]?.portfolioLevel?.netExposureTarget ?? 0.35;
  const coreBudget = safeLoadJson<any>(ensure(runDir, 'capital_budgets.json'))?.coreBudget;

  lines.push('# Round 5 — Trade Proposal & Risk Review');
  lines.push('');
  lines.push('## Proposed trades');
  lines.push(
    orders.length
      ? bulletList(orders.map((o: any) => `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.quantity ?? 'n/a'} shares of ${o.symbol || 'n/a'}`))
      : '_None_'
  );
  lines.push('');
  lines.push('## Capital usage');
  if (orders.length && coreBudget) {
    const buyNotional = orders
      .filter((o: any) => o.side === 'BUY')
      .reduce((acc: number, o: any) => acc + (o.notionalUSD || 0), 0);
    lines.push(bulletList([`Core capital deployed: ~$${buyNotional.toFixed(0)} of $${coreBudget.toFixed(0)}`, 'Reserve capital untouched']));
  } else {
    lines.push(bulletList(['Core capital usage: n/a', 'Reserve capital: n/a']));
  }
  lines.push('');
  lines.push('## Risk considerations');
  lines.push(
    bulletList([
      `Equity regime confidence: ${equityConf}`,
      `Position sizes capped at ${(maxPosPct * 100).toFixed(0)}% of NAV`,
      'No leverage used'
    ])
  );
  lines.push('');
  lines.push('## Approval status');
  lines.push('- Proposal requires human approval before execution');
  if (flags.length) {
    lines.push('');
    lines.push('## Flags');
    lines.push(bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  }
  lines.push('');
  return lines.join('\n');
};

const round6Summary = (runDir: string) => {
  const runDirRoot = path.resolve(runDir, '..');
  const current = path.basename(runDir);
  const metricsPath = ensure(runDir, 'round6_metrics.json');
  const currentMetrics = fs.existsSync(metricsPath)
    ? (JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as ReturnType<typeof computeRound6Metrics>)
    : computeRound6Metrics(current);

  // Find prior run directory (lexicographically earlier)
  const candidates = fs
    .readdirSync(runDirRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== current)
    .map((d) => d.name)
    .sort();
  const priorName = candidates.filter((n) => n < current).slice(-1)[0];
  const priorMetricsPath = priorName ? path.join(runDirRoot, priorName, 'round6_metrics.json') : undefined;
  const priorMetrics =
    priorMetricsPath && fs.existsSync(priorMetricsPath)
      ? (JSON.parse(fs.readFileSync(priorMetricsPath, 'utf-8')) as ReturnType<typeof computeRound6Metrics>)
      : undefined;

  const lines: string[] = [];
  lines.push('# Round 6 — Capital Deployment Retrospective');
  lines.push('');
  if (!priorMetrics) {
    lines.push('## Status');
    lines.push('- No prior run available for comparison');
    lines.push('');
    lines.push('## Notes');
    lines.push('- This is the first deployment cycle');
    lines.push('- Retrospective analysis will begin next week');
    lines.push('');
    lines.push('## Future weeks will include');
    lines.push('- Capital deployed vs idle');
    lines.push('- Changes in exposure');
    lines.push('- Strategy intent vs execution reality');
    lines.push('- Regime changes vs portfolio response');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Capital deployed vs idle');
  lines.push(
    bulletList([
      `Current turnover: $${currentMetrics.turnoverNotionalUSD.toFixed(2)}`,
      `Prior turnover: $${priorMetrics.turnoverNotionalUSD.toFixed(2)}`,
      `Trades this week: ${currentMetrics.trades}`
    ])
  );
  lines.push('');
  lines.push('## Changes in exposure');
  lines.push('- Exposure change analysis not implemented yet (reporting only).');
  lines.push('');
  lines.push('## Strategy intent vs execution reality');
  lines.push('- Compare orders vs fills in future iteration (not implemented).');
  lines.push('');
  lines.push('## Regime changes vs portfolio response');
  lines.push('- Regime/response comparison will be added when exposure history is tracked.');
  lines.push('');
  return lines.join('\n');
};
const summaryByRound = (runDir: string, round: number): string => {
  switch (round) {
    case 0:
      return round0Summary(runDir);
    case 1:
      return round1Summary(runDir);
    case 2:
      return round2Summary(runDir);
    case 3:
      return round3Summary(runDir);
    case 4:
      return round4Summary(runDir);
    case 5:
      return round5Summary(runDir);
    case 6:
      return round6Summary(runDir);
    default:
      return '';
  }
};

export const writeRoundSummaries = (runId: string, baseDir = process.cwd()) => {
  const runDir = path.join(baseDir, 'runs', runId);
  [0, 1, 2, 3, 4, 5, 6].forEach((r) => {
    const content = summaryByRound(runDir, r);
    if (content) write(path.join(runDir, `round${r}_summary.md`), content);
  });
  // Additional explanatory artifact for Round 0
  const expl = round0Explanation(runDir);
  if (expl) write(path.join(runDir, 'round0_explanation.md'), expl);
  // Round 1 explanation artifact mirrors summary
  const r1 = summaryByRound(runDir, 1);
  if (r1) write(path.join(runDir, 'round1_explanation.md'), r1);
  const r2 = summaryByRound(runDir, 2);
  if (r2) write(path.join(runDir, 'round2_explanation.md'), r2);
  const r3 = summaryByRound(runDir, 3);
  if (r3) write(path.join(runDir, 'round3_explanation.md'), r3);
  const r4 = summaryByRound(runDir, 4);
  if (r4) write(path.join(runDir, 'round4_explanation.md'), r4);
  const r5 = summaryByRound(runDir, 5);
  if (r5) write(path.join(runDir, 'round5_explanation.md'), r5);
  const r6 = summaryByRound(runDir, 6);
  if (r6) write(path.join(runDir, 'round6_retrospective.md'), r6);
};

// Backward-compatible name used by run.ts imports; supports optional round selection
export const generateRoundNarrative = (runId: string, round?: number, baseDir = process.cwd()) => {
  if (round === undefined) return writeRoundSummaries(runId, baseDir);
  const runDir = path.join(baseDir, 'runs', runId);
  const content = summaryByRound(runDir, round);
  if (content) write(path.join(runDir, `round${round}_summary.md`), content);
  if (round === 0) {
    const expl = round0Explanation(runDir);
    if (expl) write(path.join(runDir, 'round0_explanation.md'), expl);
  }
  if (round === 1) {
    const r1 = summaryByRound(runDir, 1);
    if (r1) write(path.join(runDir, 'round1_explanation.md'), r1);
  }
  if (round === 2) {
    const r2 = summaryByRound(runDir, 2);
    if (r2) write(path.join(runDir, 'round2_explanation.md'), r2);
  }
  if (round === 3) {
    const r3 = summaryByRound(runDir, 3);
    if (r3) write(path.join(runDir, 'round3_explanation.md'), r3);
  }
  if (round === 4) {
    const r4 = summaryByRound(runDir, 4);
    if (r4) write(path.join(runDir, 'round4_explanation.md'), r4);
  }
  if (round === 5) {
    const r5 = summaryByRound(runDir, 5);
    if (r5) write(path.join(runDir, 'round5_explanation.md'), r5);
  }
  if (round === 6) {
    const r6 = summaryByRound(runDir, 6);
    if (r6) write(path.join(runDir, 'round6_retrospective.md'), r6);
  }
};
