import 'dotenv/config';
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { parseAsOfDateTime } from '../core/time';
import { loadConfig, loadUniverse, ensureDir, readJSONFile } from '../core/utils';
import { getMarketDataProvider } from '../data/marketData';
import { getBroker } from '../broker/broker';
import { generateLLMProposal } from '../strategy/llmProposer';
import { runDeterministicBaseline } from '../strategy/deterministicBaseline';
import { runRandomBaseline } from '../strategy/randomBaseline';
import { appendEvent, getRunStatus, makeEvent } from '../ledger/ledger';
import { writeRunArtifact } from '../ledger/storage';
import { evaluateRisk } from '../risk/riskEngine';
import { currentDrawdown } from '../analytics/performance';
import { executeOrders } from '../execution/executionEngine';
import { BotConfig, ProposalResult, TradeOrder } from '../core/types';
import { generateBaseArtifacts } from './contextBuilder';
import { anchorInvalidations } from '../risk/invalidationAnchor';
import { applyDecisionPolicyGate } from '../risk/decisionPolicyGate';
import { assertRound5Input } from '../risk/round5Guards';
import { preflightAuth } from '../broker/etrade/authService';
import { planWholeShareExecution } from '../execution/wholeSharePlanner';
import { rebalancePortfolio } from '../execution/rebalanceEngine';
import { detectDislocation } from '../dislocation/dislocationDetector';
import { buildDislocationBuys } from '../execution/dislocationPlanner';
import { runSleeveLifecycle } from '../dislocation/sleeveLifecycle';
import { generateRoundNarrative } from '../narratives/roundNarrative';
import { generateRound6Metrics } from '../retrospective/metrics';
import { generateRound6Retrospective } from '../retrospective/retrospective';
import { computeOverlayBudget } from '../dislocation/overlayBudget';
import { loadExposureGroups, symbolToExposureKey, canonicalSymbolForExposure } from '../core/exposureGroups';
import { planCanonicalization } from '../execution/canonicalizeExposureGroups';
import {
  loadSleevePositions,
  reconcileSleevePositions,
  saveSleevePositions,
  snapshotSleevePositions
} from '../dislocation/sleevePositions';

const program = new Command();

program
  .option('--asof <dateTime>', 'as-of timestamp (YYYY-MM-DD or YYYY-MM-DDTHH:mm, UTC)')
  .option('--mode <mode>', 'paper | live | backtest', 'paper')
  .option('--strategy <strategy>', 'llm | deterministic | random')
  .option('--dry-run', 'simulate without placing orders', false)
  .option('--auto-exec', 'override approval gate and execute immediately', false)
  .option('--force', 'override idempotency', false);

export interface RunOptions {
  asof?: string;
  mode?: string;
  strategy?: string;
  dryRun?: boolean;
  force?: boolean;
  autoExec?: boolean;
  runId?: string;
}

const loadPreviousRegimes = (currentRunId: string): any | undefined => {
  const runsDir = path.resolve(process.cwd(), 'runs');
  if (!fs.existsSync(runsDir)) return undefined;
  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== currentRunId)
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const name of entries) {
    const p = path.join(runsDir, name, 'regimes.json');
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch {
        continue;
      }
    }
  }
  return undefined;
};

export const runBot = async (options: RunOptions) => {
  const { asof, mode, strategy, dryRun, force, autoExec, runId: providedRunId } = options;
  const { asOf, runId: computedRunId } = parseAsOfDateTime(asof);
  const runId = providedRunId || computedRunId;
  const runMode = (mode || 'paper') as string;
  const strategyOpt = strategy as string | undefined;
  const dry = Boolean(dryRun);
  const forceRun = Boolean(force);
  const auto = Boolean(autoExec);
  const auth = preflightAuth(runMode);
  if (!auth.allow) {
    console.error(auth.warning || 'E*TRADE auth not active.');
    return;
  } else if (auth.warning) {
    console.warn(auth.warning);
  }

  const status = getRunStatus(runId);
  if (!forceRun && status !== 'UNKNOWN') {
    console.log(`Run ${runId} already exists with status ${status}. Use --force to rerun.`);
    return;
  }

  const configPath = path.resolve(process.cwd(), 'src/config/default.json');
  const config: BotConfig = loadConfig(configPath);
  const rebalanceDay = config.rebalanceDay?.toUpperCase?.() ?? 'FRIDAY';
  if (config.cadence === 'weekly' && !forceRun) {
    const day = new Date(asOf).getUTCDay(); // 0 Sunday ... 6 Saturday
    const dayName = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][day];
    if (dayName !== rebalanceDay) {
      console.error(
        `Cadence is weekly. asof ${asOf} is ${dayName}, not ${rebalanceDay}. Use --force to override or adjust rebalanceDay.`
      );
      return;
    }
  }

  const universe = loadUniverse(path.resolve(process.cwd(), config.universeFile));
  const marketData = getMarketDataProvider(runMode as any);
  const broker = getBroker(config, marketData, runMode as any);
  const brokerProvider = (process.env.BROKER_PROVIDER || 'stub').toLowerCase();

  const runDir = path.resolve(process.cwd(), 'runs', runId);
  if (!forceRun && fs.existsSync(runDir) && status !== 'UNKNOWN') {
    console.log(`Run directory ${runDir} already exists. Use --force to override.`);
    return;
  }
  ensureDir(runDir);

  const { inputs } = await generateBaseArtifacts(asOf, runId, config, universe, marketData, { mode: runMode }, broker);

  appendEvent(makeEvent(runId, 'RUN_STARTED', { mode: runMode, dryRun: dry, asOf }));
  writeRunArtifact(runId, 'inputs.json', inputs);
  appendEvent(makeEvent(runId, 'INPUTS_WRITTEN', { symbols: universe.length }));

  // Sleeve positions (base vs dislocation) tracking and reconciliation
  const sleeveEnv = process.env.ETRADE_ENV || 'default';
  const sleeveAccountKey = process.env.ETRADE_ACCOUNT_ID_KEY || undefined;
  const existingSleeve = loadSleevePositions(sleeveEnv, sleeveAccountKey);
  const reconciledSleeve = reconcileSleevePositions(inputs.portfolio.holdings || [], existingSleeve);
  const sleevePositions = reconciledSleeve.positions;
  if (reconciledSleeve.flags.length) {
    writeRunArtifact(runId, 'round5_flags.json', reconciledSleeve.flags);
  }
  saveSleevePositions(sleevePositions, sleeveEnv, sleeveAccountKey);
  writeRunArtifact(runId, 'sleeve_positions_snapshot.json', snapshotSleevePositions(sleevePositions));

  let proposal: ProposalResult | null = null;
  const chosenStrategy: string = strategyOpt || (config.useLLM ? 'llm' : 'deterministic');

  if (chosenStrategy === 'llm') {
    const llmResult = await generateLLMProposal(asOf, universe, config, inputs.portfolio, marketData);
    if (llmResult.success) {
      proposal = llmResult.result;
    } else {
      appendEvent(makeEvent(runId, 'RUN_FAILED', { reason: llmResult.errors.join('; '), stage: 'LLM_VALIDATION' }));
      if (strategyOpt === 'llm') {
        console.error('LLM strategy forced and failed validation. Aborting.');
        return;
      }
      console.log('LLM validation failed; falling back to deterministic baseline.');
    }
  }

  if (!proposal) {
    if (chosenStrategy === 'random') {
      proposal = await runRandomBaseline(asOf, universe, config, inputs.portfolio, marketData);
    } else {
      proposal = await runDeterministicBaseline(asOf, universe, config, inputs.portfolio, marketData);
    }
  }

  // Anchor invalidations to deterministic supports
  const featuresPath = path.join(runDir, 'features.json');
  const features = fs.existsSync(featuresPath) ? JSON.parse(fs.readFileSync(featuresPath, 'utf-8')) : undefined;
  const anchored = features ? anchorInvalidations(proposal.intent.orders, features) : { orders: proposal.intent.orders, flags: [] };
  proposal.intent.orders = anchored.orders;
  if (anchored.flags.length) {
    writeRunArtifact(runId, 'round5_flags.json', anchored.flags);
  }

  writeRunArtifact(runId, 'proposal.json', proposal);
  appendEvent(makeEvent(runId, 'PROPOSAL_CREATED', { strategy: proposal.strategy, orderCount: proposal.intent.orders.length }));

  // Load LLM context (round 4) for exposure-cap aware planning
  const ctxPath = path.resolve(process.cwd(), 'runs', runId, 'llm_context.json');
  const llmContext = fs.existsSync(ctxPath)
    ? (JSON.parse(fs.readFileSync(ctxPath, 'utf-8')) as any)
    : undefined;

  // Whole-share execution planner (closest fit + proxies, with exposure cap awareness)
  const quotes = (inputs as any)?.quotes || {};
  const rawBudget =
    typeof inputs?.portfolio?.cash === 'number' && inputs.portfolio.cash > 0
      ? inputs.portfolio.cash
      : inputs?.portfolio?.equity ?? 0;
  const minCashUSD = Math.max(0, config.minCashPct * (inputs?.portfolio?.equity ?? rawBudget));
  const round0SummaryPath = path.join(runDir, 'round0_summary.json');
  const round0Summary = fs.existsSync(round0SummaryPath)
    ? (JSON.parse(fs.readFileSync(round0SummaryPath, 'utf-8')) as any)
    : {};
  const macroLagDays = round0Summary.macroLagDays || {};
  const macroLagWarn = config.macroLagWarnDays ?? 45;
  const hasMacroLag = Object.values(macroLagDays).some((d: any) => (d ?? 0) > macroLagWarn);
  const dataQualityRound1 = ((llmContext as any)?.dataQuality?.round1 || []) as any[];
  const hasCoarsePercentiles = dataQualityRound1.some(
    (f) => f.code === 'COARSE_PERCENTILES' || f.code === 'PERCENTILE_UNRELIABLE'
  );
  const equityConf = (llmContext as any)?.regimes?.equityRegime?.confidence ?? 0.5;
  const transitionRisk = (llmContext as any)?.regimes?.equityRegime?.transitionRisk ?? 'low';
  let exposureCap = 1.0;
  const netExposureTarget = proposal.intent.orders[0]?.portfolioLevel?.netExposureTarget;
  if (netExposureTarget !== undefined) exposureCap = Math.min(exposureCap, netExposureTarget);
  if (equityConf < 0.35) exposureCap = Math.min(exposureCap, 0.35);
  else if (equityConf < 0.6) exposureCap = Math.min(exposureCap, 0.6);
  if (hasMacroLag) exposureCap = Math.min(exposureCap, 0.7);
  if (hasCoarsePercentiles) exposureCap = Math.min(exposureCap, 0.7);
  if (transitionRisk === 'high') exposureCap = Math.min(exposureCap, 0.35);
  else if (transitionRisk === 'elevated') exposureCap = Math.min(exposureCap, 0.6);
  const baseExposureCap = exposureCap;
  const capBudget = (inputs?.portfolio?.equity ?? rawBudget) * exposureCap;
  const buyBudgetUSD = Math.max(0, Math.min(rawBudget - minCashUSD, capBudget));
  const proxiesMap: Record<string, string[]> =
    config.allowExecutionProxies && config.proxiesFile
      ? readJSONFile<Record<string, string[]>>(path.resolve(process.cwd(), config.proxiesFile))
      : {};
  const exposureGroups = config.enableExposureGrouping
    ? loadExposureGroups(config.exposureGroupsFile)
    : {};
  const round0FlagsPath = path.join(runDir, 'round0_flags.json');
  const round0Flags = fs.existsSync(round0FlagsPath) ? JSON.parse(fs.readFileSync(round0FlagsPath, 'utf-8')) : [];
  if (config.allowExecutionProxies) {
    const proxySymbols = new Set<string>();
    Object.values(proxiesMap).forEach((arr) => arr.forEach((p) => proxySymbols.add(p)));
    for (const sym of proxySymbols) {
      if (quotes[sym]) continue;
      try {
        const q = await marketData.getQuote(sym, asOf);
        quotes[sym] = q.price;
      } catch (err) {
        round0Flags.push({
          code: 'QUOTE_FETCH_FAILED',
          severity: 'warn',
          message: `Proxy quote fetch failed for ${sym}`,
          symbols: [sym],
          observed: { error: (err as Error).message }
        });
      }
    }
  }
  // Flag quote failures explicitly
  const missingSymbols: string[] = [];
  for (const [sym, px] of Object.entries(quotes)) {
    if (typeof px !== 'number' || px <= 0) missingSymbols.push(sym);
  }
  if (config.allowExecutionProxies) {
    const proxySymbols = new Set<string>();
    Object.values(proxiesMap).forEach((arr) => arr.forEach((p) => proxySymbols.add(p)));
    for (const sym of proxySymbols) {
      if (!quotes[sym]) missingSymbols.push(sym);
    }
    // If proxy price missing but original has price, backfill from original to keep plan viable.
    for (const [orig, proxies] of Object.entries(proxiesMap)) {
      const origPx = quotes[orig];
      if (typeof origPx === 'number' && origPx > 0) {
        for (const p of proxies) {
          if (typeof quotes[p] !== 'number' || quotes[p] <= 0) {
            quotes[p] = origPx;
            round0Flags.push({
              code: 'QUOTE_PROXY_BACKFILL',
              severity: 'info',
              message: `Backfilled proxy ${p} price from original ${orig}`,
              symbols: [p],
              observed: { from: orig, price: origPx }
            });
            missingSymbols.splice(missingSymbols.indexOf(p), 1);
          }
        }
      }
    }
  }
  if (missingSymbols.length) {
    for (const sym of Array.from(new Set(missingSymbols))) {
      round0Flags.push({
        code: 'QUOTE_MISSING_PRICE',
        severity: 'warn',
        message: `Missing price for ${sym}`,
        symbols: [sym]
      });
    }
  }
  if (round0Flags.length) {
    writeRunArtifact(runId, 'round0_flags.json', round0Flags);
  }
  const priorFlags =
    (fs.existsSync(path.join(runDir, 'round5_flags.json'))
      ? JSON.parse(fs.readFileSync(path.join(runDir, 'round5_flags.json'), 'utf-8'))
      : []) || [];
  const proxyParentMap: Record<string, string> = {};
  Object.entries(proxiesMap || {}).forEach(([parent, proxies]) => {
    proxies.forEach((p) => {
      proxyParentMap[p] = parent;
    });
  });

  const planner = planWholeShareExecution({
    targets: proposal.intent.orders.map((o) => ({ symbol: o.symbol, notionalUSD: o.notionalUSD, priority: o.confidence })),
    prices: quotes,
    buyBudgetUSD,
    minCashUSD,
    allowPartial: true,
    minViablePositions: 1,
    maxAbsWeightError: 0.2,
    proxyMap: proxiesMap,
    allowProxies: config.allowExecutionProxies,
    maxProxyTrackingErrorAbs: config.maxProxyTrackingErrorAbs,
    exposureGroups
  });
  writeRunArtifact(runId, 'execution_plan.json', planner);
  writeRunArtifact(runId, 'execution_substitutions.json', planner.substitutions || []);
  const combinedFlags = [...priorFlags, ...(planner.flags || [])];
  if (combinedFlags.length) {
    writeRunArtifact(runId, 'round5_flags.json', combinedFlags);
  }
  if (planner.status === 'UNEXECUTABLE') {
    writeRunArtifact(runId, 'orders.json', []);
    writeRunArtifact(runId, 'fills.json', [{ type: 'NO_FILL', reason: 'UNEXECUTABLE_WHOLE_SHARE' }]);
    appendEvent(makeEvent(runId, 'RUN_FAILED', { reason: 'UNEXECUTABLE_WHOLE_SHARE' }));
    console.error('Execution plan unexecutable; no orders generated.');
    return;
  }
  if (planner.status === 'PARTIAL') {
    console.warn('Execution plan is partial; proceeding with feasible subset.');
  }
  const originalBySymbol = new Map(proposal.intent.orders.map((o) => [o.symbol, o]));
  const originalByExecuted = new Map(
    (planner.substitutions || []).map((s) => [s.executedSymbol, s.originalSymbol ?? s.executedSymbol])
  );

  const featureBySymbol: Record<string, any> = {};
  if (Array.isArray(features)) {
    for (const f of features) featureBySymbol[f.symbol] = f;
  }
  const extractDrawdownPct = (txt?: string) => {
    if (!txt) return undefined;
    const m = txt.match(/drawdown\s*>\s*([0-9.]+)/i);
    return m ? Number(m[1]) : undefined;
  };
  const adjustedInvalidation = (baseInv: string | undefined, baseSym: string, execSym: string) => {
    const baseF = featureBySymbol[baseSym];
    const execPx = quotes[execSym];
    if (!baseF || !execPx) return baseInv || '';
    const drawPct = extractDrawdownPct(baseInv) ?? 4;
    const basePx = Number(baseF.price || 0);
    const ma200 = Number(baseF.ma200 || 0);
    const ratio = basePx > 0 && ma200 > 0 ? ma200 / basePx : 0.95; // if missing, fallback to 5% below price
    const proxyMa200 = ratio > 0 ? execPx * ratio : execPx * 0.95;
    return `Invalidate if weekly close < MA200 (${proxyMa200.toFixed(2)}) or drawdown > ${drawPct}% from entry.`;
  };

  // Map planner target orders into enriched buy-only orders (used for target plan)
  const targetOrdersEnriched = planner.orders.map((o) => {
    const originalSymbol = originalByExecuted.get(o.symbol) || (o as any).originalSymbol || o.symbol;
    const baseOriginal = originalBySymbol.get(originalSymbol) || originalBySymbol.get(o.symbol);
    const basePL = baseOriginal?.portfolioLevel;
    return {
      symbol: o.symbol,
      side: baseOriginal?.side || o.side,
      orderType: 'MARKET',
      notionalUSD: o.estNotionalUSD,
      thesis: baseOriginal?.thesis || '',
      invalidation: adjustedInvalidation(baseOriginal?.invalidation, originalSymbol, o.symbol),
      confidence: baseOriginal?.confidence ?? 0.5,
      portfolioLevel: basePL ? { ...basePL } : { targetHoldDays: 30, netExposureTarget: 1 }
    } as TradeOrder;
  });

  const drawdown = await currentDrawdown(config, marketData);
  const proxySymbolsUsed = (planner.substitutions || [])
    .filter((s) => s.reason === 'PROXY_SUBSTITUTION')
    .map((s) => s.executedSymbol);
  if (proxySymbolsUsed.length) {
    proposal.intent.universe = Array.from(new Set([...(proposal.intent.universe || []), ...proxySymbolsUsed]));
  }

  // Detect dislocation (market-wide drawdown) and write artifacts
  const dislocation = detectDislocation(asOf, config, inputs.history as any, quotes);
  writeRunArtifact(runId, 'dislocation.json', dislocation);
  if (dislocation.flags.length) writeRunArtifact(runId, 'dislocation_flags.json', dislocation.flags);

  // Sleeve lifecycle to manage ADD/HOLD/REINTEGRATE and protect sells
  const sleeveLifecycle = runSleeveLifecycle({
    asOf,
    config,
    dislocationActive: dislocation.tierEngaged ?? false,
    anchorPrice: quotes[config.dislocation?.anchorSymbol || 'SPY'],
    regimes: llmContext?.regimes,
    tier: dislocation.tier
  });
  writeRunArtifact(runId, 'dislocation_state.json', sleeveLifecycle.state);
  if (sleeveLifecycle.flags.length) {
    writeRunArtifact(runId, 'dislocation_flags.json', [
      ...(dislocation.flags || []),
      ...sleeveLifecycle.flags
    ]);
  }

  // Rebalance: compare current holdings vs target plan and emit sells+buys
  const priceMap: Record<string, number> = { ...quotes };
  for (const o of planner.orders) {
    if (!priceMap[o.symbol]) priceMap[o.symbol] = o.estPrice || 0;
  }
  for (const h of inputs.portfolio.holdings || []) {
    if (!priceMap[h.symbol]) priceMap[h.symbol] = h.avgPrice || 0;
  }
  // Ensure deployment target quotes are available for opportunistic buys
  if (dislocation.tierEngaged && config.dislocation?.deploymentTargets) {
    for (const t of config.dislocation.deploymentTargets) {
      if (!priceMap[t.symbol]) {
        try {
          const q = await marketData.getQuote(t.symbol, asOf);
          priceMap[t.symbol] = q.price;
        } catch {
          // ignore
        }
      }
    }
  }
  const priorRegimes = loadPreviousRegimes(runId);
  const freezeBase = (config.dislocation?.freezeBaseRebalanceDuringAddHold ?? true) &&
    (sleeveLifecycle.state.phase === 'ADD' || sleeveLifecycle.state.phase === 'HOLD');
  const riskOffExit =
    llmContext?.regimes?.equityRegime?.label === 'risk_off' &&
    (llmContext?.regimes?.equityRegime?.confidence ?? 0) >= (config.dislocation?.earlyExit?.riskOffConfidenceThreshold ?? 0.7);
  const rebalance = rebalancePortfolio({
    asOf,
    portfolio: inputs.portfolio,
    prices: priceMap,
    targetPlan: planner,
    regimes: llmContext?.regimes,
    priorRegimes,
    proxyParentMap,
    config,
    protectFromSells: sleeveLifecycle.protectFromSells,
    protectedSymbols: (config.dislocation?.deploymentTargets || []).map((t) => proxyParentMap[t.symbol] || t.symbol),
    sleevePositions,
    freezeBaseRebalance: freezeBase,
    riskOffExit,
    exposureGroups
  });
  writeRunArtifact(runId, 'rebalance.json', rebalance);

  if (rebalance.status === 'SKIPPED_NO_DRIFT' || rebalance.status === 'SKIPPED_NO_CHANGES') {
    proposal.intent.orders = [];
    writeRunArtifact(runId, 'orders.json', []);
    writeRunArtifact(runId, 'fills.json', [{ type: 'NO_FILL', reason: 'NO_REBALANCE_DRIFT_BELOW_THRESHOLD' }]);
    console.log('Rebalance skipped due to drift thresholds.');
    return;
  }
  if (rebalance.status === 'UNEXECUTABLE') {
    proposal.intent.orders = [];
    writeRunArtifact(runId, 'orders.json', []);
    writeRunArtifact(runId, 'fills.json', [{ type: 'NO_FILL', reason: 'REBALANCE_UNEXECUTABLE' }]);
    appendEvent(makeEvent(runId, 'RUN_FAILED', { reason: 'REBALANCE_UNEXECUTABLE' }));
    return;
  }

  // Opportunistic dislocation buys (incremental)
  let dislocationExtraOrders: TradeOrder[] = [];
  if (sleeveLifecycle.allowAdd && config.dislocation?.enabled) {
    const extra = config.dislocation.overlayExtraExposurePct ?? config.dislocation.opportunisticExtraExposurePct ?? 0;
    const maxTotal = config.dislocation.maxTotalExposureCapPct ?? 1.0;
    if (extra > 0) {
      let basePlannedBuysUSD = 0;
      let basePlannedSellsUSD = 0;
      for (const o of rebalance.combinedOrders || []) {
        if (o.side === 'BUY') basePlannedBuysUSD += o.notionalUSD || 0;
        else basePlannedSellsUSD += o.notionalUSD || 0;
      }
      const currentInvestedUSD = (inputs.portfolio.equity ?? 0) - (inputs.portfolio.cash ?? 0);
  const overlayTargets =
    (config.dislocation.overlayTargets && config.dislocation.overlayTargets.length
      ? config.dislocation.overlayTargets
      : []) || [];
  const overlayExposureKeys = config.dislocation.overlayExposureKeys || [];
  const overlaySymbolsFromExposure: Array<{ symbol: string; weight: number }> = [];
  if (overlayExposureKeys.length && exposureGroups) {
    overlayExposureKeys.forEach((key) => {
      const canonical = canonicalSymbolForExposure(exposureGroups, key, priceMap, config.dislocation?.overlayMinOneShareRule);
      if (canonical) overlaySymbolsFromExposure.push({ symbol: canonical, weight: 1 });
    });
  }
  const overlayTargetsEffective =
    overlayTargets.length > 0 ? overlayTargets : overlaySymbolsFromExposure.length ? overlaySymbolsFromExposure : [];
  const cheapestOverlayPrice = overlayTargetsEffective
    .map((t) => priceMap[t.symbol])
    .filter((p) => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b)[0];
      const overlayBudget = computeOverlayBudget({
        equityUSD: inputs.portfolio.equity ?? rawBudget,
        cashUSD: inputs.portfolio.cash ?? 0,
        minCashUSD,
        overlayExtraExposurePct: extra,
        maxTotalExposureCapPct: maxTotal,
        currentInvestedUSD,
        cheapestOverlayPrice,
        overlayMinBudgetUSD: config.dislocation.overlayMinBudgetUSD
      });
      const maxSpendOverride = overlayBudget.overlayBudgetUSD;
      if (maxSpendOverride > 0 && overlayTargetsEffective.length) {
        const extraPlan = buildDislocationBuys({
          overlayTargets: overlayTargetsEffective,
          overlayBudgetUSD: maxSpendOverride,
          prices: priceMap,
          maxSpendOverride
        });
        dislocationExtraOrders = extraPlan.orders.map((o) => ({
          symbol: o.symbol,
          side: o.side || 'BUY',
          orderType: 'MARKET',
          notionalUSD: o.estNotionalUSD ?? o.quantity * (o.estPrice || priceMap[o.symbol] || 0),
          thesis: o.thesis || 'Opportunistic dislocation buy.',
          invalidation: o.invalidation || '',
          confidence: o.confidence ?? 0.6,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 },
          sleeve: 'dislocation'
        }));
        if (dislocationExtraOrders.length) {
          const existingFlags =
            (fs.existsSync(path.join(runDir, 'round5_flags.json'))
              ? JSON.parse(fs.readFileSync(path.join(runDir, 'round5_flags.json'), 'utf-8'))
              : []) || [];
          existingFlags.push({
            code: 'DISLOCATION_ACTIVE',
            severity: 'info',
            message: 'Opportunistic dislocation buys added',
            observed: { extraPct: extra, dislocationCap: maxTotal, baseExposureCap, overlayBudgetUSD: maxSpendOverride }
          });
          writeRunArtifact(runId, 'round5_flags.json', existingFlags);
        }
      }
      const overlayBudgetPath = path.join(runDir, 'overlay_budget.json');
      fs.writeFileSync(overlayBudgetPath, JSON.stringify(overlayBudget, null, 2));
      const existingFlags =
        (fs.existsSync(path.join(runDir, 'round5_flags.json'))
          ? JSON.parse(fs.readFileSync(path.join(runDir, 'round5_flags.json'), 'utf-8'))
          : []) || [];
      if (overlayBudget.flags.length) {
        writeRunArtifact(runId, 'round5_flags.json', [...existingFlags, ...overlayBudget.flags]);
      } else {
        writeRunArtifact(runId, 'round5_flags.json', existingFlags);
      }
    }
  }

  // Canonicalization during reintegrate phase
  if (
    config.canonicalizeExposureGroups &&
    (config.canonicalizeOnlyInPhase || ['REINTEGRATE']).includes(sleeveLifecycle.state.phase || '') &&
    exposureGroups &&
    Object.keys(exposureGroups).length
  ) {
    const canonicalPlan = planCanonicalization({
      exposureGroups,
      holdings: inputs.portfolio.holdings || [],
      prices: priceMap,
      sleevePositions,
      config,
      phase: sleeveLifecycle.state.phase || '',
      protectFromSells: sleeveLifecycle.protectFromSells,
      protectedSymbols: (config.dislocation?.deploymentTargets || []).map((t) => proxyParentMap[t.symbol] || t.symbol),
      equity: inputs.portfolio.equity ?? rawBudget
    });
    if (canonicalPlan.orders.length) {
      proposal.intent.orders = [...proposal.intent.orders, ...canonicalPlan.orders];
    }
    if (canonicalPlan.flags.length) {
      const existingFlags =
        (fs.existsSync(path.join(runDir, 'round5_flags.json'))
          ? JSON.parse(fs.readFileSync(path.join(runDir, 'round5_flags.json'), 'utf-8'))
          : []) || [];
      writeRunArtifact(runId, 'round5_flags.json', [...existingFlags, ...canonicalPlan.flags]);
    }
    writeRunArtifact(runId, 'canonicalization_plan.json', canonicalPlan);
  }

  const thesisMap = new Map(targetOrdersEnriched.map((o) => [o.symbol, o]));
  const rebalanceOrdersEnriched = rebalance.combinedOrders.map((o) => {
    const base = thesisMap.get(o.symbol) || thesisMap.get(proxyParentMap[o.symbol] || '');
    return {
      ...o,
      thesis:
        base?.thesis ||
        o.thesis ||
        (o.side === 'SELL' ? 'Rebalance trim to target weight.' : 'Rebalance add to target weight.'),
      invalidation: base?.invalidation || o.invalidation || '',
      confidence: o.confidence ?? base?.confidence ?? 0.5,
      portfolioLevel: base?.portfolioLevel ?? o.portfolioLevel ?? { targetHoldDays: 0, netExposureTarget: 1 }
    };
  });

  // Combine rebalance orders with dislocation incremental buys
  proposal.intent.orders = [...rebalanceOrdersEnriched, ...dislocationExtraOrders];

  // Decision policy gate (exposure/confidence caps)
  let riskReport = evaluateRisk(proposal.intent, config, inputs.portfolio, { drawdown });
  if (llmContext) {
    const meta = fs.existsSync(path.join(runDir, 'context_meta.json'))
      ? (JSON.parse(fs.readFileSync(path.join(runDir, 'context_meta.json'), 'utf-8')) as any)
      : undefined;
    if (meta) {
      assertRound5Input(llmContext, meta);
    }
    const gateResult = applyDecisionPolicyGate(proposal.intent, llmContext, inputs.portfolio, config, dislocation);
    const existingFlags =
      (fs.existsSync(path.join(runDir, 'round5_flags.json'))
        ? JSON.parse(fs.readFileSync(path.join(runDir, 'round5_flags.json'), 'utf-8'))
        : []) as any[];
    const mergedFlags = [...existingFlags, ...(gateResult.flags || [])];
    writeRunArtifact(runId, 'round5_flags.json', mergedFlags);

    proposal.intent.orders = gateResult.orders;
    riskReport.approvedOrders = gateResult.orders;
    riskReport.policyApplied = gateResult.policyApplied;
  }

  riskReport = evaluateRisk(proposal.intent, config, inputs.portfolio, { drawdown });
  writeRunArtifact(runId, 'risk_report.json', riskReport);
  appendEvent(makeEvent(runId, 'RISK_EVALUATED', { approved: riskReport.approved, blocked: riskReport.blockedReasons }));

  writeRunArtifact(runId, 'orders.json', riskReport.approvedOrders);
  writeRunArtifact(runId, 'fills.json', []);

  if (!riskReport.approved) {
    appendEvent(makeEvent(runId, 'RUN_FAILED', { reason: riskReport.blockedReasons }));
    console.error('Run blocked by risk engine.');
    console.error(`Reasons: ${riskReport.blockedReasons.join('; ')}`);
    [0, 1, 2, 3, 4, 5].forEach((r) => generateRoundNarrative(runId, r as any));
    generateRound6Metrics(runId);
    generateRound6Retrospective(runId);
    return;
  }

  const requireApproval = config.requireApproval && !auto;

  if (requireApproval && !dry) {
    appendEvent(makeEvent(runId, 'RUN_PENDING_APPROVAL', { orders: riskReport.approvedOrders.length }));
    console.log(`Run ${runId} pending approval. Review via UI before execution.`);
    // Write sentinel fills/flags
    await executeOrders(runId, asOf, riskReport.approvedOrders, broker, config, {
      pendingApproval: true,
      mode: runMode as any,
      brokerProvider
    });
    const existingFlags =
      (fs.existsSync(path.join(runDir, 'round5_flags.json'))
        ? JSON.parse(fs.readFileSync(path.join(runDir, 'round5_flags.json'), 'utf-8'))
        : []) || [];
    existingFlags.push({ code: 'EXECUTION_SKIPPED_PENDING_APPROVAL', severity: 'info', message: 'Awaiting approval' });
    writeRunArtifact(runId, 'round5_flags.json', existingFlags);
    [0, 1, 2, 3, 4, 5].forEach((r) => generateRoundNarrative(runId, r as any));
    generateRound6Metrics(runId);
    generateRound6Retrospective(runId);
    return;
  }

  if (dry) {
    appendEvent(makeEvent(runId, 'RUN_COMPLETED', { dryRun: true }));
    console.log(`Dry run completed for ${runId}.`);
    [0, 1, 2, 3, 4, 5].forEach((r) => generateRoundNarrative(runId, r as any));
    generateRound6Metrics(runId);
    generateRound6Retrospective(runId);
    return;
  }

  const execution = await executeOrders(runId, asOf, riskReport.approvedOrders, broker, config, {
    dryRun: dry,
    mode: runMode as any,
    brokerProvider
  });
  appendEvent(makeEvent(runId, 'RUN_COMPLETED', { fills: execution.fills.length }));
  console.log(`Run ${runId} completed with ${execution.fills.length} fills.`);
  [0, 1, 2, 3, 4, 5].forEach((r) => generateRoundNarrative(runId, r as any));
  generateRound6Metrics(runId);
  generateRound6Retrospective(runId);
};

const run = async () => {
  const opts = program.parse(process.argv).opts();
  await runBot({
    asof: opts.asof,
    mode: opts.mode,
    strategy: opts.strategy,
    dryRun: opts.dryRun,
    force: opts.force,
    autoExec: opts.autoExec
  });
};

if (require.main === module) {
  run().catch((err) => {
    const { runId } = parseAsOfDateTime();
    appendEvent(makeEvent(runId, 'RUN_FAILED', { error: (err as Error).message }));
    console.error(err);
    process.exitCode = 1;
  });
}
