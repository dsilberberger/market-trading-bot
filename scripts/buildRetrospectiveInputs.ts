import fs from 'fs';
import path from 'path';

type Maybe<T> = T | null;

const readJson = <T = any>(p: string): Maybe<T> => {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const loadExposureGroups = () => {
  const p = path.resolve(process.cwd(), 'src/config/exposure_groups.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<
      string,
      { members: string[]; canonicalPreference?: string[]; description?: string }
    >;
  } catch {
    return null;
  }
};

const sumNotional = (orders: any[] | undefined) =>
  (orders || []).reduce((acc, o) => acc + (o.notionalUSD ?? o.estNotionalUSD ?? 0), 0);

const resolveRunDir = (runIdOrDir?: string): string => {
  if (!runIdOrDir) throw new Error('runId or runDir is required');
  const asPath = path.resolve(process.cwd(), runIdOrDir);
  if (fs.existsSync(asPath) && fs.lstatSync(asPath).isDirectory()) return asPath;
  const candidate = path.resolve(process.cwd(), 'runs', runIdOrDir);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`run directory not found for ${runIdOrDir}`);
};

const main = () => {
  const arg = process.argv.find((a) => a.startsWith('--run'));
  const runArg = arg ? arg.split('=')[1] : process.argv[2];
  const runDir = resolveRunDir(runArg);

  const get = (fname: string) => readJson(path.join(runDir, fname));

  const capitalPools = get('capitalPools.json');
  const capitalDeployment = get('capital_deployment.json');
  const budgets = get('capital_budgets.json');
  const execPlan = get('execution_plan.json');
  const execSubs = get('execution_substitutions.json') || get('execution_substitutions');
  const budgetEnforcement = get('budgetEnforcement.json');
  const regimes = get('regimes.json');
  const features = get('features.json');
  const orders = get('orders.json') || get('etfOrders.json');
  const optionOrders = get('optionOrders.json');
  const fills = get('fills.json');
  const executionFlags = get('execution_flags.json');
  const riskReport = get('risk_report.json');
  const marketMemo = get('market_memo.json');
  const news = get('news_headlines.json');
  const sleeveSnap = get('sleeve_positions_snapshot.json');
  const ranking = execPlan?.targetWeights || regimes?.targetRanking;
  const dataSources = get('data_sources.json');
  const exposureGroups = loadExposureGroups();

  const plannedOrders = execPlan?.orders || [];
  const plannedNotional = sumNotional(plannedOrders);
  const executedNotional = sumNotional(orders?.orders || orders || plannedOrders);
  const confidenceScale = capitalDeployment?.basis?.confidenceScale;
  const derivedCapPct =
    capitalDeployment?.coreDeployPct && confidenceScale && confidenceScale > 0
      ? capitalDeployment.coreDeployPct / confidenceScale
      : null;

  const facts = {
    metadata: {
      runDir,
      runId: path.basename(runDir),
      generatedAtISO: new Date().toISOString()
    },
    capital: {
      navUsd: capitalPools?.navUsd ?? budgets?.nav ?? null,
      corePoolUsd: capitalPools?.corePoolUsd ?? budgets?.coreBudget ?? null,
      reservePoolUsd: capitalPools?.reservePoolUsd ?? budgets?.reserveBudget ?? null,
      deployPct: capitalDeployment?.coreDeployPct ?? null,
      deployBudgetUsd: capitalDeployment?.deployBudgetUsd ?? null,
      basis: capitalDeployment?.basis ?? null,
      baseExposureCapPct: derivedCapPct
    },
    regimes: regimes ?? null,
    features: features ?? null,
    dataSources: dataSources ?? null,
    execution: {
      plannedOrders,
      plannedNotionalUSD: plannedNotional,
      achievedNotionalUSD: executedNotional,
      leftoverCashUSD: execPlan?.leftoverCashUSD ?? budgetEnforcement?.etf?.coreRemainingUsd ?? null,
      substitutions: execSubs?.substitutions || execPlan?.substitutions || [],
      budgetEnforcement,
      executionFlags: executionFlags || []
    },
    orders: {
      etfOrders: orders?.orders || orders || [],
      optionOrders: optionOrders?.orders || optionOrders || [],
      fills: fills || []
    },
    sleeves: sleeveSnap || null,
    risk: riskReport || null,
    marketContext: {
      memo: marketMemo || null,
      news: news || null
    },
    ranking: ranking || [],
    exposures: exposureGroups || null,
    notes: []
  };

  const outPath = path.join(runDir, 'retrospective_inputs.json');
  fs.writeFileSync(outPath, JSON.stringify(facts, null, 2));
  console.log(`retrospective_inputs.json written to ${outPath}`);
};

if (require.main === module) {
  main();
}
