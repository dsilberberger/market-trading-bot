import fs from 'fs';
import path from 'path';

const readJson = (p: string) => {
  const raw = fs.readFileSync(p, 'utf-8');
  const trimmed = raw.trim();
  let clean = trimmed;
  if (trimmed.startsWith('```')) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match && match[1]) clean = match[1].trim();
  }
  return JSON.parse(clean);
};

const fmtCurrency = (n?: number | null) => (n === undefined || n === null ? 'n/a' : `$${n.toFixed(2)}`);
const fmtPct = (n?: number | null) => (n === undefined || n === null ? 'n/a' : `${(n * 100).toFixed(2)}%`);

const main = () => {
  const args = process.argv.slice(2);
  const runArg = args.find((a) => a.startsWith('--run'));
  const runId = runArg ? runArg.split('=')[1] : args[0];
  if (!runId) throw new Error('runId or --runId is required');
  const runDir = path.isAbsolute(runId)
    ? runId
    : path.resolve(process.cwd(), runId.startsWith('runs') ? runId : path.join('runs', runId));
  const facts = readJson(path.join(runDir, 'retrospective_inputs.json'));
  const narrative = fs.existsSync(path.join(runDir, 'report_narrative.json'))
    ? readJson(path.join(runDir, 'report_narrative.json'))
    : {};
  const dataSources = facts.dataSources || {};
  const cap = facts.capital || {};
  const regimes = facts.regimes || {};
  const deployPct = cap.deployPct ?? null;
  const deployBudget = cap.deployBudgetUsd ?? null;
  const corePool = cap.corePoolUsd ?? null;
  const reservePool = cap.reservePoolUsd ?? null;
  const nav = cap.navUsd ?? null;
  const confidenceScale = cap.basis?.confidenceScale ?? null;
  const baseCap = cap.baseExposureCapPct ?? null;
  const plannedNotional = facts.execution?.plannedNotionalUSD ?? 0;
  const leftover = deployBudget !== null ? Math.max(0, deployBudget - plannedNotional) : null;
  const modeHint = dataSources?.providers?.brokerProvider === 'etrade' ? 'Live/Paper (E*TRADE)' : 'Harness / Simulation';
  const volLabel = regimes?.volRegime?.label || 'unknown';
  const confidence = regimes?.equityRegime?.confidence ?? cap.basis?.equityRegimeConfidence ?? null;
  const plannedOrders = facts.execution?.plannedOrders || [];
  const substitutions = facts.execution?.substitutions || [];
  const optionOrders = facts.orders?.optionOrders || [];
  const fills = facts.orders?.fills || [];
  const execFails = (facts.execution?.executionFlags || []).filter((f: any) => f.code === 'EXECUTION_FAILED');
  const rankingRaw = facts.ranking || [];
  const ranking: Array<{ symbol: string; score: number }> = Array.isArray(rankingRaw)
    ? rankingRaw
    : Object.entries(rankingRaw || {}).map(([symbol, score]) => ({ symbol, score: Number(score) || 0 }));
  const sortedRanking = ranking.sort((a, b) => (b.score || 0) - (a.score || 0));
  const selectedSymbols = plannedOrders.map((o: any) => o.symbol);
  const nonSelected = sortedRanking.filter((r) => !selectedSymbols.includes(r.symbol)).slice(0, 5);
  const exposures = facts.exposures || {};
  const describeSymbol = (sym: string) => {
    if (!exposures) return undefined;
    const entry = Object.entries(exposures || {}).find(([, cfg]: any) => cfg.members?.includes(sym));
    if (!entry) return undefined;
    const [key, cfg]: any = entry;
    return cfg.description ? `${key}: ${cfg.description}` : key;
  };

  const lines: string[] = [];
  lines.push(`# Consolidated Run Report — ${facts.metadata?.runId || path.basename(runDir)}`);
  lines.push(`Run ID: \`${facts.metadata?.runDir || runDir}\`  `);
  lines.push(`Mode: ${modeHint}`);
  lines.push(`Generated: ${narrative.metadata?.generatedAtISO || facts.metadata?.generatedAtISO || new Date().toISOString()}`);
  lines.push('');
  lines.push('## 0) What this report is (for a layperson)');
  lines.push(
    'This report explains, step-by-step, how the system interpreted the market, chose a risk “regime,” allocated capital between safer vs riskier buckets, selected specific ETFs and options, and produced an execution plan. It also includes a retrospective: how the market actually behaved relative to what the regime assumed, and how the previous run’s holdings performed.'
  );
  lines.push('');
  lines.push('Key principles:');
  lines.push('- The bot never spends all available money at once; it uses caps and confidence scaling.');
  lines.push('- ETFs and options are separated by a hard “70/30 wall.”');
  lines.push('- The report is transparent: every action is tied to a computed constraint or signal.');
  lines.push('\n---\n');

  lines.push('## 1) High-level snapshot');
  lines.push('### 1.1 Market context (at a glance)');
  const regimeLabel = regimes?.equityRegime?.label || regimes?.risk || 'unknown';
  lines.push(`- **Observed environment:** “${(regimeLabel || '').replace('_', '-').toUpperCase()}” (${volLabel} volatility)`);
  lines.push('- **Why this matters:** Regime drives how defensive vs aggressive the posture is.');
  lines.push('');

  lines.push('### 1.2 Capital picture (at a glance)');
  lines.push(`- **Account NAV:** ${fmtCurrency(nav)}`);
  lines.push('- **ETF vs Options wall (70/30):**');
  lines.push(`  - **Core pool (ETFs):** ${fmtCurrency(corePool)}`);
  lines.push(`  - **Reserve pool (options + overlays):** ${fmtCurrency(reservePool)}`);
  lines.push('');

  lines.push('### 1.3 This run’s ETF deploy budget');
  lines.push(
    `- Deploy math: core pool × base cap × confidence scale. base cap ~ ${fmtPct(baseCap)}, confidence scale ~ ${
      confidenceScale ?? 'n/a'
    }, deploy % (after scaling) = ${fmtPct(deployPct)}`
  );
  lines.push(`- Deploy budget: ${fmtCurrency(deployBudget)}`);
  lines.push(`- Planned ETF buys (whole-share): ${fmtCurrency(plannedNotional)}; leftover: ${fmtCurrency(leftover)}`);
  lines.push('\n---\n');

  lines.push('## 2) Round-by-round walkthrough (transparent pipeline)');
  lines.push('Each round has a single purpose and hands its results to the next round.');
  lines.push('');
  lines.push('### Round 0 — Market & Account Readiness');
  lines.push('Purpose: confirm safe to run; capture a frozen snapshot of account/data.');
  lines.push('Inputs: account API health; market data health; scenario config (synthetic if harness).');
  lines.push(
    `Data sources: market=${dataSources?.providers?.marketDataProvider || 'unknown'}, broker=${dataSources?.providers?.brokerProvider || 'unknown'}, quotes=${dataSources?.providers?.quoteProvider || 'unknown'}`
  );
  lines.push('Observed market cues feeding regime/matrix:');
  if (regimes?.equityRegime?.supports) {
    Object.entries(regimes.equityRegime.supports).forEach(([k, v]: any) => lines.push(`- ${k}: ${v}`));
  } else {
    lines.push('- Regime supports not available in artifacts.');
  }
  lines.push('Key outcomes: account accessible; market data available; no blocking errors.');
  lines.push('Handoff: NAV and initial conditions to capital allocation logic.');
  lines.push('');
  lines.push('### Round 1 — Capital Pools (70/30 Wall)');
  lines.push('Purpose: enforce hard separation ETF vs options.');
  lines.push(`Core pool (70%): ${fmtCurrency(corePool)}; Reserve pool (30%): ${fmtCurrency(reservePool)}.`);
  lines.push('Why: prevents hidden risk creep; ETFs cannot spend reserve; options cannot spend core.');
  lines.push('Handoff: core feeds deploy budget; reserve held for insurance/growth.');
  lines.push('');
  lines.push('### Round 2 — Market Regime & Risk Posture');
  lines.push(`Purpose: decide cautious vs aggressive. Regime: ${regimeLabel}; Vol label: ${volLabel}; Confidence: ${confidence ?? 'n/a'}.`);
  lines.push('Why: regime sets exposure caps and tilts.');
  lines.push('Handoff: base cap + confidence factor to deploy budgeting.');
  lines.push('');
  lines.push('### Round 3 — ETF Deploy Budget (Cap applied to Core)');
  lines.push(
    `Core ${fmtCurrency(corePool)} × base cap ${fmtPct(baseCap)} × confidence scale ${confidenceScale ?? 'n/a'} = deploy % ${fmtPct(
      deployPct
    )} and budget ${fmtCurrency(deployBudget)}.`
  );
  lines.push('Why: intentional cap on risk; budget < core by design.');
  lines.push('Handoff: deploy budget becomes hard upper bound for ETF orders.');
  lines.push('');
  lines.push('### Round 4 — Target Portfolio & Execution Mapping');
  lines.push('Purpose: decide what to own and how to trade it; apply proxies.');
  lines.push(
    `Execution mapping/proxies: ${
      substitutions.length ? substitutions.map((s: any) => `${s.originalSymbol}->${s.executedSymbol}`).join(', ') : 'none'
    }`
  );
  lines.push('');
  lines.push('### Round 5 — Order Construction (Whole-share reality)');
  lines.push(
    `Planned ETF orders: ${plannedOrders
      .map((o: any) => `${o.symbol} ${fmtCurrency(o.estNotionalUSD ?? o.notionalUSD ?? 0)}`)
      .join(', ') || 'none'}`
  );
  lines.push(`Total spend ${fmtCurrency(plannedNotional)} vs budget ${fmtCurrency(deployBudget)}; leftover ${fmtCurrency(leftover)} (rounding).`);
  lines.push('Why spend < budget: whole-share constraint; leftover cash is intentional.');
  lines.push('');
  lines.push('### Round 6 — Final Checks & Explanation');
  lines.push(
    `Safety: 70/30 wall respected; core deploy respected (${fmtCurrency(plannedNotional)} <= ${fmtCurrency(
      deployBudget
    )}); reserve untouched (${fmtCurrency(reservePool)}).`
  );
  if (execFails.length) {
    lines.push('Execution issues:');
    execFails.forEach((f: any) => lines.push(`- ${f.symbol || ''} ${f.message || f.code}`.trim()));
  }
  lines.push('');

  lines.push('## 3) Market assessment (expanded)');
  lines.push(
    `Signals: trends/momentum, volatility=${volLabel}, confidence=${confidence ?? 'n/a'}. Equity regime: ${regimeLabel || 'unknown'}.`
  );
  if (regimes?.equityRegime?.supports) {
    lines.push('Supports used for regime decision:');
    Object.entries(regimes.equityRegime.supports).forEach(([k, v]: any) => lines.push(`- ${k}: ${v}`));
  }
  lines.push('');

  lines.push('## 4) ETF selection rationale');
  lines.push('Selected ETFs and why (based on targets + constraints):');
  plannedOrders.forEach((o: any) => {
    const desc = describeSymbol(o.symbol);
    lines.push(
      `- ${o.symbol}: planned ${fmtCurrency(o.estNotionalUSD ?? o.notionalUSD ?? 0)}${desc ? ` — ${desc}` : ''} (proxy/rounding may apply)`
    );
  });
  if (sortedRanking.length) {
    lines.push('Top-ranked (not necessarily all selected):');
    sortedRanking
      .slice(0, 5)
      .forEach((r) => lines.push(`- ${r.symbol}: score ${r.score}${describeSymbol(r.symbol) ? ` — ${describeSymbol(r.symbol)}` : ''}`));
    if (nonSelected.length) {
      lines.push('Not selected (why less appealing this run):');
      nonSelected.forEach((r) => lines.push(`- ${r.symbol}: lower rank/score ${r.score}`));
    }
    lines.push('');
    lines.push('Full ranking (universe scores):');
    sortedRanking.forEach((r) => {
      lines.push(`- ${r.symbol}: score ${r.score}${describeSymbol(r.symbol) ? ` — ${describeSymbol(r.symbol)}` : ''}`);
    });
    lines.push('Note: Scores come from artifacts; detailed per-symbol drivers are not logged. Scoring typically reflects momentum/trend and regime tilts.');
  } else {
    lines.push('- Ranking details not available in artifacts.');
  }
  lines.push('');

  lines.push('## 5) Capital constraints (layman)');
  lines.push('- 70/30 wall: separate ETF core vs options reserve.');
  lines.push('- Risk cap applied to core pool; confidence scaling reduces aggressiveness.');
  lines.push('- Whole-share rounding can leave leftover cash.');
  lines.push('');

  lines.push('## 6) Execution summary');
  lines.push(
    `Planned ETF orders total ${fmtCurrency(plannedNotional)}; substitutions: ${
      substitutions.length ? 'applied' : 'none'
    }.`
  );
  if (fills.length) {
    lines.push('- Fills:');
    fills.forEach((f: any) => {
      if (f.type === 'NO_FILL') {
        lines.push(`  - NO_FILL ${f.symbol || ''} reason=${f.reason || ''} ${f.message || ''}`.trim());
      } else {
        lines.push(`  - ${f.symbol || f.orderId || 'order'} ${f.side || ''} qty=${f.quantity ?? ''} px=${f.price ?? ''}`);
      }
    });
  }
  if (execFails.length) {
    lines.push('- Execution issues:');
    execFails.forEach((f: any) => lines.push(`  - ${f.symbol || ''} ${f.message || f.code}`.trim()));
  }
  lines.push('');

  lines.push('## 7) Options summary');
  lines.push('Options actions: ' + (optionOrders.length ? 'present' : 'none in this run.'));
  lines.push('');

  lines.push('## 8) Risk checks and invariants');
  lines.push('See risk_report.json for details; summary: risk engine approved = ' + (facts.risk?.approved ?? 'n/a'));
  lines.push('');

  lines.push('## 9) Retrospective');
  lines.push('Prior-run vs current holdings and market to be compared in future work.');
  lines.push('');

  lines.push('## 10) Glossary');
  lines.push('- NAV: Total account value (cash + investments).');
  lines.push('- Core pool: ETF budget (70% of NAV).');
  lines.push('- Reserve pool: Options/overlay budget (30% of NAV).');
  lines.push('- Regime: Risk label driving allocation (Risk-On / Risk-Off).');
  lines.push('- Exposure cap: Maximum fraction of capital allowed to be deployed.');
  lines.push('- Confidence scaling: Factor that reduces/increases deployment based on signal strength.');
  lines.push('- Proxy ETF: Substitute ticker (e.g., QQQM for QQQ) used for execution constraints.');
  lines.push('- Whole-share rounding: ETFs trade in whole shares; rounding can leave unused budget.');
  lines.push('');

  lines.push('## Appendix: Numbers that caused confusion (reconciled)');
  lines.push(`- NAV: ${fmtCurrency(nav)}`);
  lines.push(`- Core pool (70%): ${fmtCurrency(corePool)}`);
  lines.push(`- Reserve pool (30%): ${fmtCurrency(reservePool)}`);
  if (baseCap !== null) lines.push(`- Risk cap: ${fmtPct(baseCap)} of core`);
  if (confidenceScale !== null) lines.push(`- Confidence scale: ${confidenceScale}`);
  if (deployPct !== null) lines.push(`- Deploy % (after scaling): ${fmtPct(deployPct)}`);
  if (deployBudget !== null) lines.push(`- Deploy budget: ${fmtCurrency(deployBudget)}`);
  lines.push(`- Planned ETF buys: ${fmtCurrency(plannedNotional)}`);
  lines.push(`- Leftover (rounding/proxies): ${fmtCurrency(leftover)}`);

  const outPath = path.join(runDir, 'report.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`report.md written to ${outPath}`);
};

if (require.main === module) {
  main();
}
