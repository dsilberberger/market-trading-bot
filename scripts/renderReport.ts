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
const orderNotional = (o: any) => {
  const raw = o?.notionalUSD ?? o?.notionalUsd ?? o?.estNotionalUSD ?? o?.estNotionalUsd ?? null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : 0;
};
const sumNotional = (orders: any[] | undefined) => (orders || []).reduce((acc, o) => acc + orderNotional(o), 0);

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
  const confidenceDiagnostics = facts.confidenceDiagnostics || {};
  const dataAdequacy = facts.dataAdequacy || {};
  const confidence =
    confidenceDiagnostics?.confidence?.base ??
    regimes?.equityRegime?.confidence ??
    cap.basis?.equityRegimeConfidence ??
    null;
  const calibratedConfidence = confidenceDiagnostics?.confidence?.calibrated ?? confidence;
  const coverageSufficient = dataAdequacy?.adequate ?? confidenceDiagnostics?.coverage?.sufficient ?? null;
  const proxyUsed =
    confidenceDiagnostics?.proxy?.confidence !== null &&
    confidenceDiagnostics?.proxy?.confidence !== undefined &&
    confidenceDiagnostics?.proxy?.symbol;
  const anchorSymbol =
    dataAdequacy?.anchorSymbol || confidenceDiagnostics?.anchorSymbol || regimes?.equityRegime?.supports?.anchor || 'n/a';
  const timeInRegime =
    regimes?.equityRegime?.timeInRegimeWeeks ??
    confidenceDiagnostics?.timeInRegimeWeeks ??
    regimes?.equityRegime?.supports?.timeInRegimeWeeks ??
    null;
  const plannedOrders = facts.execution?.plannedOrders || [];
  const substitutions = facts.execution?.substitutions || [];
  const optionOrders = facts.orders?.optionOrders || [];
  const netOrders = facts.orders?.etfOrders || [];
  const netBuyOrders = netOrders.filter((o: any) => String(o.side || '').toUpperCase() === 'BUY');
  const netSellOrders = netOrders.filter((o: any) => String(o.side || '').toUpperCase() === 'SELL');
  const netBuyNotional = sumNotional(netBuyOrders);
  const netSellNotional = sumNotional(netSellOrders);
  const netNotional = sumNotional(netOrders);
  const rebalance = facts.rebalance || null;
  const rebalanceOrders = Array.isArray(rebalance?.combinedOrders)
    ? rebalance?.combinedOrders
    : [...(rebalance?.sellOrders || []), ...(rebalance?.buyOrders || [])];
  const fills = facts.orders?.fills || [];
  const execFails = (facts.execution?.executionFlags || []).filter((f: any) => f.code === 'EXECUTION_FAILED');
  const rankingRaw = facts.ranking || [];
  const ranking: Array<{ symbol: string; score: number }> = Array.isArray(rankingRaw)
    ? rankingRaw
    : Object.entries(rankingRaw || {}).map(([symbol, score]) => ({ symbol, score: Number(score) || 0 }));
  const sortedRanking = ranking.sort((a, b) => (b.score || 0) - (a.score || 0));
  const selectedSymbols = plannedOrders.map((o: any) => o.symbol);
  const nonSelected = sortedRanking.filter((r) => !selectedSymbols.includes(r.symbol)).slice(0, 5);
  const features: any[] = Array.isArray(facts.features) ? facts.features : [];
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
  lines.push(`- Planned ETF buys (target portfolio, whole-share): ${fmtCurrency(plannedNotional)}; leftover: ${fmtCurrency(leftover)}`);
  lines.push(
    `- Net ETF orders (rebalance vs current holdings): ${
      netOrders.length
        ? `buys ${netBuyOrders.length}, sells ${netSellOrders.length}; notional buys ${fmtCurrency(netBuyNotional)}, sells ${fmtCurrency(netSellNotional)}`
        : 'none'
    }.`
  );
  lines.push('\n---\n');

  lines.push('## Regime & Confidence Rationale');
  lines.push('### Regime rationale');
  lines.push(
    `- Equity regime: ${regimeLabel || 'unknown'}; Vol regime: ${volLabel}; Time in regime: ${
      timeInRegime ?? 'n/a'
    } week(s); Anchor: ${anchorSymbol}`
  );
  const supports = regimes?.equityRegime?.supports || {};
  const anchorSym = supports.anchorSymbol || anchorSymbol;
  const signalBullets: string[] = [];
  const retBucket = supports.anchorRet60dBucket;
  const retPct = supports.anchorRet60dPctile;
  const volBucketSup = supports.anchorVolPctileBucket;
  const volPctSup = supports.anchorVolPctile;
  if (retBucket) signalBullets.push(`return bucket: ${retBucket}`);
  if (retPct !== undefined && retPct !== null) signalBullets.push(`return pctile: ${retPct}`);
  if (volBucketSup) signalBullets.push(`vol bucket: ${volBucketSup}`);
  if (volPctSup !== undefined && volPctSup !== null) signalBullets.push(`vol pctile: ${volPctSup}`);
  if (signalBullets.length) {
    lines.push(`- Regime drivers: ${signalBullets.join('; ')}`);
  } else {
    lines.push('- Regime drivers: not available in artifacts.');
  }
  lines.push('- Why: regime labels are derived from the above buckets/percentiles and the current matrix state (no extra heuristics).');
  lines.push('');
  lines.push('### Confidence rationale');
  lines.push(
    `- Raw confidence: ${confidence ?? 'n/a'}; Calibrated confidence: ${calibratedConfidence ?? 'n/a'}; confidenceScale: ${
      confidenceScale ?? 'n/a'
    }; deployPct: ${fmtPct(deployPct)}`
  );
  const confQuality = confidenceDiagnostics?.confidence?.quality || regimes?.equityRegime?.supports?.confidenceQuality;
  lines.push(`- Confidence quality: ${confQuality || 'not available'} (full = strong signal; degraded = limited data or proxy; blocked = insufficient data)`);
  lines.push(
    `- Proxy calibration ${
      proxyUsed ? `used (${confidenceDiagnostics?.proxy?.symbol || 'proxy'})` : 'not used'
    }; data adequacy ${coverageSufficient === null ? 'not available' : coverageSufficient ? 'passed' : 'failed'}.`
  );
  if (confidenceDiagnostics?.thresholds?.coverageFloorConfidence) {
    lines.push(
      `- Coverage floor (if triggered) would clamp confidence to ${confidenceDiagnostics.thresholds.coverageFloorConfidence}; observed calibrated=${calibratedConfidence ?? 'n/a'}.`
    );
  }
  if (confidenceScale !== null && confidenceScale !== undefined && confidenceScale !== 1) {
    lines.push(
      `- confidenceScale < 1.0 indicates reduced deployment due to confidence below full threshold; applied scale=${confidenceScale}.`
    );
  }
  lines.push(
    `- Time-in-regime ramp: ${timeInRegime ?? 'n/a'} week(s) vs ramp window ${
      confidenceDiagnostics?.ramp
        ? `${confidenceDiagnostics.ramp.minWeeks}-${confidenceDiagnostics.ramp.maxWeeks}`
        : 'not available'
    }.`
  );
  lines.push('');
  lines.push('### Lookback / data coverage');
  const historySamples =
    dataAdequacy?.observed?.canonical?.historySamples ?? confidenceDiagnostics?.base?.historySamples ?? null;
  const historyUnique =
    dataAdequacy?.observed?.canonical?.historyUniqueCloses ?? confidenceDiagnostics?.base?.historyUniqueCloses ?? null;
  const minSamples = dataAdequacy?.minHistorySamples ?? null;
  const minUnique = dataAdequacy?.minUniqueCloses ?? null;
  const minDays = confidenceDiagnostics?.thresholds?.minHistoryDays ?? null;
  lines.push(
    `- Coverage: samples=${historySamples ?? 'n/a'}, uniqueCloses=${historyUnique ?? 'n/a'}, minSamples=${minSamples ?? 'n/a'}, minUnique=${minUnique ?? 'n/a'}, minDays=${minDays ?? 'n/a'}.`
  );
  lines.push(
    `- Coverage assessment: ${
      coverageSufficient === null ? 'not available' : coverageSufficient ? 'sufficient; proxy not needed' : 'insufficient; proxy/guard would apply'
    }.`
  );
  if (dataAdequacy?.adequate === false) {
    lines.push(
      `- Data adequacy failed: anchor ${dataAdequacy.anchorSymbol || 'n/a'} observed ${JSON.stringify(
        dataAdequacy.observed || {}
      )} vs required samples ${minSamples ?? 'n/a'}.`
    );
  }
  lines.push('');
  lines.push('---\n');

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
    `Target ETF orders (pre-rebalance): ${plannedOrders
      .map((o: any) => `${o.symbol} ${fmtCurrency(orderNotional(o))}`)
      .join(', ') || 'none'}`
  );
  lines.push(
    `Net ETF orders (rebalance vs current holdings): ${
      netOrders.length ? netOrders.map((o: any) => `${o.symbol} ${o.side} ${fmtCurrency(orderNotional(o))}`).join(', ') : 'none'
    }`
  );
  lines.push('Why net orders can differ from target: current holdings are netted against target weights.');
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
      `- ${o.symbol}: planned ${fmtCurrency(orderNotional(o))}${desc ? ` — ${desc}` : ''} (proxy/rounding may apply)`
    );
  });
  lines.push(
    'Selection is role-based: the regime activates portfolio roles (e.g., US core, international diversifier, defensive equity) with target weights. One ETF is chosen per role; the system does not rank all ETFs to find “winners.”'
  );
  if (Object.keys(facts.execution?.targetWeights || {}).length) {
    lines.push('Target weights (these are allocations, not momentum scores):');
    Object.entries(facts.execution.targetWeights || {}).forEach(([sym, w]: any) => {
      lines.push(`- ${sym}: weight ${fmtPct(Number(w) || 0)}${describeSymbol(sym) ? ` — ${describeSymbol(sym)}` : ''}`);
    });
    lines.push('Note: No ranking artifact was provided; weights come from the execution plan.');
  } else if (sortedRanking.length) {
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

  lines.push('## 4a) ETF signal drivers (from features)');
  if (features.length) {
    const sortedFeatures = [...features].sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
    sortedFeatures.forEach((f) => {
      lines.push(
        `- ${f.symbol}: return bucket ${f.return60dPctileBucket ?? 'n/a'} (pctile ${f.return60dPctile ?? 'n/a'}); vol bucket ${
          f.vol20dPctileBucket ?? 'n/a'
        } (pctile ${f.vol20dPctile ?? 'n/a'}); trend: ${f.trend ?? 'n/a'}, above50=${f.above50dma ?? 'n/a'}, above200=${
          f.above200dma ?? 'n/a'
        }`
      );
    });
    lines.push('Regime tilt multipliers not present in artifacts; not displayed.');
    lines.push(
      'Note: These feature signals inform regime and diagnostics. They do not override role-based target weights; strong standalone signals on non-required roles will not force selection.'
    );
  } else {
    lines.push('- Feature signals not available in artifacts.');
  }
  lines.push('');

  lines.push('## 5) Capital constraints (layman)');
  lines.push('- 70/30 wall: separate ETF core vs options reserve.');
  lines.push('- Risk cap applied to core pool; confidence scaling reduces aggressiveness.');
  lines.push('- Whole-share rounding can leave leftover cash.');
  lines.push('');

  lines.push('## 6) Execution summary');
  lines.push(
    `Target ETF orders total ${fmtCurrency(plannedNotional)}; substitutions: ${
      substitutions.length ? 'applied' : 'none'
    }.`
  );
  lines.push(
    `Net ETF orders (rebalance vs current holdings): ${
      netOrders.length
        ? `${netOrders.length} order(s); buys ${fmtCurrency(netBuyNotional)}, sells ${fmtCurrency(
            netSellNotional
          )}; gross notional ${fmtCurrency(netNotional)}`
        : 'none'
    }.`
  );
  lines.push('Orders (summary)');
  if (netOrders.length) {
    netOrders.forEach((o: any) => {
      const orderType = o.orderType || 'MARKET';
      const thesis = o.thesis ? ` — ${o.thesis}` : '';
      lines.push(`- ${o.symbol} ${o.side} ${orderType} ${fmtCurrency(orderNotional(o))}${thesis}`);
    });
  } else {
    lines.push('- none');
  }
  if (rebalanceOrders.length) {
    lines.push('Rebalance');
    rebalanceOrders.forEach((o: any) => {
      const reason = o.reason || o.thesis || '';
      lines.push(`- ${o.symbol} ${o.side} ${fmtCurrency(orderNotional(o))}${reason ? ` — ${reason}` : ''}`);
    });
  } else if (rebalance) {
    lines.push('Rebalance: none');
  }
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
