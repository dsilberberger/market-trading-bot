import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'refined_variant';

interface ExperimentVariant {
  key: VariantKey;
  label: string;
  baseConfigPath: string;
}

interface ExperimentWindow {
  key: string;
  label: string;
  classification: string;
  bundlePath: string;
}

interface ScaleRunMetrics {
  scale: number;
  configPath: string;
  outputDir: string;
  strategyReturnPct: number;
  maxDrawdownPct: number;
  endingValue: number;
  annualizedVolatilityPct: number | null;
  tradeCount: number;
  averageRealizedEquityAllocation: number;
  planner: {
    positiveTargetSteps: number;
    constrainedSteps: number;
    plannerUnexecutableSteps: number;
    plannerOneSymbolSteps: number;
    omittedCoreEquitySteps: number;
    omittedCoreEquityCounts: Record<string, number>;
    averageLeftoverCashUSD: number;
    averageBuyBudgetUSD: number;
    averageConstrainedBuyBudgetUSD: number;
    pctStepsAffordableTwoEquity: number;
    pctConstrainedStepsAffordableTwoEquity: number;
    pctStepsAffordableFullBasket: number;
    pctConstrainedStepsAffordableFullBasket: number;
  };
  risk: {
    plannedBuyNotional: number;
    approvedBuyNotional: number;
    approvedBuyNotionalPctOfPlanned: number;
    stepsWithPlannedBuys: number;
    stepsWithApprovedBuys: number;
    stepsWithRiskBlockedBuys: number;
    stepsWithRiskReducedBuys: number;
  };
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  variants: Record<VariantKey, ScaleRunMetrics[]>;
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/execution_comparability_experiment');
const GENERATED_CONFIG_ROOT = path.join(OUTPUT_ROOT, 'generated_configs');
const CORE_EQUITY = new Set(['VTI', 'VTV', 'USMV', 'VXUS']);
const SCALES = [1, 2, 3];

const VARIANTS: ExperimentVariant[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    baseConfigPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'refined_variant',
    label: 'Refined planner diagnostic',
    baseConfigPath: path.join(ROOT, 'src/config/default.refined_subset_scoring_planner.json')
  }
];

const WINDOWS: ExperimentWindow[] = [
  {
    key: 'nasdaq_2016-12-13_2019-12-31',
    label: '2016-12-13 -> 2019-12-31',
    classification: 'real external, unadjusted',
    bundlePath: path.join(ROOT, 'research/broad_validation/bundles/nasdaq_2016-12-13_2019-12-31_weekly.json')
  },
  {
    key: 'yahoo_adjusted_2010-01-01_2015-12-31',
    label: '2010-01-01 -> 2015-12-31',
    classification: 'adjusted near-canonical',
    bundlePath: path.join(ROOT, 'research/broad_validation/bundles/yahoo_adjusted_2010-01-01_2015-12-31_weekly.json')
  }
];

const round = (value: number, digits = 6) => Number(value.toFixed(digits));

const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const buildCloseMap = (bundle: HistoricalReplayInput) => {
  const closeMap = new Map<string, Record<string, number>>();
  for (const [symbol, series] of Object.entries(bundle.series)) {
    for (const bar of series) {
      const date = String(bar.date).slice(0, 10);
      const existing = closeMap.get(date) || {};
      existing[symbol] = bar.close;
      closeMap.set(date, existing);
    }
  }
  return closeMap;
};

const buildEquitySet = (groups: ExposureGroups) => {
  const equity = new Set<string>();
  for (const [key, spec] of Object.entries(groups)) {
    if (!key.includes('EQUITY')) continue;
    for (const member of spec.members || []) equity.add(member);
  }
  return equity;
};

const computeAverageRealizedEquityAllocation = (
  holdingsHistory: Array<{ date: string; holdings: Array<{ symbol: string; quantity: number; avgPrice?: number }>; cash: number }>,
  closeMap: Map<string, Record<string, number>>,
  equitySet: Set<string>
) => {
  const values: number[] = [];
  for (const step of holdingsHistory) {
    const closes = closeMap.get(String(step.date).slice(0, 10)) || {};
    let equityValue = 0;
    let totalValue = step.cash || 0;
    for (const holding of step.holdings || []) {
      const mark = closes[holding.symbol] ?? holding.avgPrice ?? 0;
      const marketValue = (holding.quantity || 0) * mark;
      totalValue += marketValue;
      if (equitySet.has(holding.symbol)) equityValue += marketValue;
    }
    if (totalValue > 0) values.push(equityValue / totalValue);
  }
  return average(values);
};

const buildScaledConfig = (variant: ExperimentVariant, scale: number) => {
  const base = readJson<BotConfig>(variant.baseConfigPath);
  const scaled: BotConfig = {
    ...base,
    startingCapitalUSD: base.startingCapitalUSD * scale
  };
  const configPath = path.join(GENERATED_CONFIG_ROOT, `${variant.key}.scale_${scale}x.json`);
  writeJson(configPath, scaled);
  return configPath;
};

const summarizeScaleRun = (
  result: HistoricalReplayResult,
  bundle: HistoricalReplayInput,
  exposureGroups: ExposureGroups
): ScaleRunMetrics => {
  const validation = readJson<any>(path.join(result.outputDir, 'validation_summary.json'));
  const holdingsHistory = readJson<any[]>(path.join(result.outputDir, 'holdings_history.json'));
  const closeMap = buildCloseMap(bundle);
  const equitySet = buildEquitySet(exposureGroups);
  const strategy = validation.portfolios.find((entry: any) => entry.type === 'strategy');

  const plannerBuyBudgets: number[] = [];
  const constrainedBuyBudgets: number[] = [];
  let positiveTargetSteps = 0;
  let constrainedSteps = 0;
  let plannerUnexecutableSteps = 0;
  let plannerOneSymbolSteps = 0;
  let omittedCoreEquitySteps = 0;
  const omittedCoreEquityCounts: Record<string, number> = {};
  let leftoverCashSum = 0;
  let affordableTwoEquitySteps = 0;
  let affordableTwoEquityConstrainedSteps = 0;
  let affordableFullBasketSteps = 0;
  let affordableFullBasketConstrainedSteps = 0;

  let plannedBuyNotional = 0;
  let approvedBuyNotional = 0;
  let stepsWithPlannedBuys = 0;
  let stepsWithApprovedBuys = 0;
  let stepsWithRiskBlockedBuys = 0;
  let stepsWithRiskReducedBuys = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const plan = readJson<any>(path.join(runDir, 'execution_plan.json'));
    const deploy = readJson<any>(path.join(runDir, 'capital_deployment.json'));
    const budgetEnforcement = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    const riskReport = readJson<any>(path.join(runDir, 'risk_report.json'));

    const targetSymbols = Object.keys(plan.targetWeights || {});
    if (!targetSymbols.length) continue;
    positiveTargetSteps += 1;

    const buyBudgetUSD = Number(deploy.buyBudgetUSD || 0);
    plannerBuyBudgets.push(buyBudgetUSD);

    const substitutions = Array.isArray(plan.substitutions) ? plan.substitutions : [];
    const targeted = substitutions
      .filter((entry: any) => (entry.targetWeight || 0) > 0 && (entry.priceExecuted || entry.priceOriginal || 0) > 0)
      .map((entry: any) => ({
        symbol: entry.originalSymbol,
        price: entry.priceExecuted || entry.priceOriginal
      }));

    const fullBasketCost = targeted.reduce((sum: number, entry: { symbol: string; price: number }) => sum + entry.price, 0);
    const equityPrices = targeted
      .filter((entry: { symbol: string; price: number }) => CORE_EQUITY.has(entry.symbol))
      .map((entry: { symbol: string; price: number }) => entry.price)
      .sort((left: number, right: number) => left - right);
    const twoEquityCost = equityPrices.length >= 2 ? equityPrices[0] + equityPrices[1] : Number.POSITIVE_INFINITY;

    if (buyBudgetUSD >= twoEquityCost) affordableTwoEquitySteps += 1;
    if (buyBudgetUSD >= fullBasketCost) affordableFullBasketSteps += 1;

    const selectedCount = (plan.selectedSymbols || []).length;
    const constrained = plan.status === 'UNEXECUTABLE' || selectedCount < targetSymbols.length;
    if (constrained) {
      constrainedSteps += 1;
      constrainedBuyBudgets.push(buyBudgetUSD);
      if (buyBudgetUSD >= twoEquityCost) affordableTwoEquityConstrainedSteps += 1;
      if (buyBudgetUSD >= fullBasketCost) affordableFullBasketConstrainedSteps += 1;
    }

    if (plan.status === 'UNEXECUTABLE') plannerUnexecutableSteps += 1;
    if (selectedCount === 1) plannerOneSymbolSteps += 1;
    leftoverCashSum += plan.leftoverCashUSD || 0;

    const omittedCore = targetSymbols.filter((symbol) => CORE_EQUITY.has(symbol) && !(plan.selectedSymbols || []).includes(symbol));
    if (omittedCore.length) {
      omittedCoreEquitySteps += 1;
      for (const symbol of omittedCore) omittedCoreEquityCounts[symbol] = (omittedCoreEquityCounts[symbol] || 0) + 1;
    }

    const plannedStepBuyNotional = Number(budgetEnforcement?.etf?.plannedBuyUsd || 0);
    const approvedStepBuyNotional = Array.isArray(riskReport?.approvedOrders)
      ? riskReport.approvedOrders
          .filter((order: any) => order.side === 'BUY')
          .reduce((sum: number, order: any) => sum + Number(order.notionalUSD || 0), 0)
      : 0;

    plannedBuyNotional += plannedStepBuyNotional;
    approvedBuyNotional += approvedStepBuyNotional;
    if (plannedStepBuyNotional > 0) stepsWithPlannedBuys += 1;
    if (approvedStepBuyNotional > 0) stepsWithApprovedBuys += 1;
    if (plannedStepBuyNotional > 0 && approvedStepBuyNotional === 0) stepsWithRiskBlockedBuys += 1;
    if (approvedStepBuyNotional > 0 && approvedStepBuyNotional + 1e-9 < plannedStepBuyNotional) stepsWithRiskReducedBuys += 1;
  }

  return {
    scale: 1,
    configPath: '',
    outputDir: result.outputDir,
    strategyReturnPct: strategy.totalReturnPct,
    maxDrawdownPct: strategy.maxDrawdownPct,
    endingValue: strategy.endingValue,
    annualizedVolatilityPct: strategy.annualizedVolatilityPct ?? null,
    tradeCount: strategy.tradeCount,
    averageRealizedEquityAllocation: round(computeAverageRealizedEquityAllocation(holdingsHistory, closeMap, equitySet)),
    planner: {
      positiveTargetSteps,
      constrainedSteps,
      plannerUnexecutableSteps,
      plannerOneSymbolSteps,
      omittedCoreEquitySteps,
      omittedCoreEquityCounts,
      averageLeftoverCashUSD: round(leftoverCashSum / Math.max(positiveTargetSteps, 1), 3),
      averageBuyBudgetUSD: round(average(plannerBuyBudgets), 3),
      averageConstrainedBuyBudgetUSD: round(average(constrainedBuyBudgets), 3),
      pctStepsAffordableTwoEquity: round(affordableTwoEquitySteps / Math.max(positiveTargetSteps, 1), 4),
      pctConstrainedStepsAffordableTwoEquity: round(affordableTwoEquityConstrainedSteps / Math.max(constrainedSteps, 1), 4),
      pctStepsAffordableFullBasket: round(affordableFullBasketSteps / Math.max(positiveTargetSteps, 1), 4),
      pctConstrainedStepsAffordableFullBasket: round(affordableFullBasketConstrainedSteps / Math.max(constrainedSteps, 1), 4)
    },
    risk: {
      plannedBuyNotional: round(plannedBuyNotional, 3),
      approvedBuyNotional: round(approvedBuyNotional, 3),
      approvedBuyNotionalPctOfPlanned: round(approvedBuyNotional / Math.max(plannedBuyNotional, 1e-9), 6),
      stepsWithPlannedBuys,
      stepsWithApprovedBuys,
      stepsWithRiskBlockedBuys,
      stepsWithRiskReducedBuys
    }
  };
};

const buildMemo = (windowSummaries: WindowSummary[]) => {
  const modern = windowSummaries.find((entry) => entry.windowKey.includes('nasdaq'));
  const adjusted = windowSummaries.find((entry) => entry.windowKey.includes('yahoo_adjusted'));
  if (!modern || !adjusted) return '';

  const baselineModern = modern.variants.baseline;
  const baselineAdjusted = adjusted.variants.baseline;
  const refinedAdjusted = adjusted.variants.refined_variant;

  const modern1x = baselineModern.find((entry) => entry.scale === 1)!;
  const modern2x = baselineModern.find((entry) => entry.scale === 2)!;
  const modern3x = baselineModern.find((entry) => entry.scale === 3)!;
  const adjusted1x = baselineAdjusted.find((entry) => entry.scale === 1)!;
  const adjusted2x = baselineAdjusted.find((entry) => entry.scale === 2)!;
  const adjusted3x = baselineAdjusted.find((entry) => entry.scale === 3)!;

  const refinedAdjusted1x = refinedAdjusted.find((entry) => entry.scale === 1)!;
  const refinedAdjusted2x = refinedAdjusted.find((entry) => entry.scale === 2)!;
  const refinedAdjusted3x = refinedAdjusted.find((entry) => entry.scale === 3)!;

  return `# Execution Comparability Memo

## A. Headline
The larger-account ladder shows that a large share of the remaining planner pathology is geometric. In the modern window, the promoted baseline improves steadily as scale rises and diversified baskets become more affordable. In the adjusted window, scale also relieves a significant part of the planner stress, but it does not eliminate all basket-quality sensitivity.

## B. Modern Window
At 1x scale, the promoted baseline can afford a 2-equity basket on only ${(modern1x.planner.pctStepsAffordableTwoEquity * 100).toFixed(1)}% of positive-target steps, with average buy budget $${modern1x.planner.averageBuyBudgetUSD.toFixed(2)}. By 2x, that rises to ${(modern2x.planner.pctStepsAffordableTwoEquity * 100).toFixed(1)}%, and by 3x it rises to ${(modern3x.planner.pctStepsAffordableTwoEquity * 100).toFixed(1)}%. Planner-unexecutable steps fall ${modern1x.planner.plannerUnexecutableSteps} -> ${modern2x.planner.plannerUnexecutableSteps} -> ${modern3x.planner.plannerUnexecutableSteps}, while one-symbol plans fall ${modern1x.planner.plannerOneSymbolSteps} -> ${modern2x.planner.plannerOneSymbolSteps} -> ${modern3x.planner.plannerOneSymbolSteps}. That means the modern pathology is mostly a small-account whole-share artifact.

## C. Adjusted Window
The adjusted window is less dominated by geometry, but still materially distorted by it. A 2-equity basket is already affordable on ${(adjusted1x.planner.pctStepsAffordableTwoEquity * 100).toFixed(1)}% of positive-target steps at 1x, rising to ${(adjusted2x.planner.pctStepsAffordableTwoEquity * 100).toFixed(1)}% at 2x and ${(adjusted3x.planner.pctStepsAffordableTwoEquity * 100).toFixed(1)}% at 3x. Full-basket affordability improves from ${(adjusted1x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% to ${(adjusted2x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% to ${(adjusted3x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}%.

The diagnostic refined planner still underperforms the promoted baseline in the adjusted window at 1x (${(refinedAdjusted1x.strategyReturnPct * 100).toFixed(2)}% vs ${(adjusted1x.strategyReturnPct * 100).toFixed(2)}%), but the degradation should be interpreted inside a still-constrained geometry. The critical point is that scale reduces the distortion enough to make further planner work more interpretable.

## D. Recommendation
The next seam should remain execution-comparability, not more planner tuning. The scale ladder confirms that the modern problem mostly vanishes as baskets become affordable, while the adjusted window remains mixed but less distorted. Planner logic should pause until the larger-scale results are reviewed; if harmful basket behavior still persists at 2x/3x with materially better affordability, planner tuning becomes the next seam with much cleaner evidence.`;
};

const run = async () => {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.mkdirSync(GENERATED_CONFIG_ROOT, { recursive: true });

  const exposureGroups = readJson<ExposureGroups>(path.join(ROOT, 'src/config/exposure_groups_small.json'));
  const windowSummaries: WindowSummary[] = [];

  for (const window of WINDOWS) {
    const bundle = readJson<HistoricalReplayInput>(window.bundlePath);
    const variantSummaries: WindowSummary['variants'] = {
      baseline: [],
      refined_variant: []
    };

    for (const variant of VARIANTS) {
      for (const scale of SCALES) {
        const configPath = buildScaledConfig(variant, scale);
        const outputDir = path.join(OUTPUT_ROOT, window.key, variant.key, `scale_${scale}x`);
        const runPrefix = `replay-scale-${variant.key}-${window.key}-scale${scale}x`;
        const result = await runHistoricalReplay({
          input: bundle,
          configPath,
          outputDir,
          runPrefix,
          strategy: 'deterministic'
        });
        const metrics = summarizeScaleRun(result, bundle, exposureGroups);
        metrics.scale = scale;
        metrics.configPath = path.relative(ROOT, configPath);
        variantSummaries[variant.key].push(metrics);
      }
    }

    windowSummaries.push({
      windowKey: window.key,
      windowLabel: window.label,
      classification: window.classification,
      variants: variantSummaries
    });
  }

  const summaryPath = path.join(OUTPUT_ROOT, 'comparison_summary.json');
  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    experiment: 'execution_comparability_scale_ladder',
    scales: SCALES,
    windows: windowSummaries
  });

  const csvLines = [
    'window,variant,scale,return_pct,max_drawdown_pct,ending_value,avg_realized_equity,planner_unexecutable,planner_one_symbol,omitted_core_equity_steps,avg_leftover_cash,avg_buy_budget,pct_affordable_two_equity,pct_affordable_full_basket,approved_buy_notional_pct_planned'
  ];
  for (const window of windowSummaries) {
    for (const [variantKey, runs] of Object.entries(window.variants) as Array<[VariantKey, ScaleRunMetrics[]]>) {
      for (const runMetrics of runs) {
        csvLines.push(
          [
            window.windowKey,
            variantKey,
            String(runMetrics.scale),
            round(runMetrics.strategyReturnPct),
            round(runMetrics.maxDrawdownPct),
            round(runMetrics.endingValue, 3),
            round(runMetrics.averageRealizedEquityAllocation),
            String(runMetrics.planner.plannerUnexecutableSteps),
            String(runMetrics.planner.plannerOneSymbolSteps),
            String(runMetrics.planner.omittedCoreEquitySteps),
            round(runMetrics.planner.averageLeftoverCashUSD, 3),
            round(runMetrics.planner.averageBuyBudgetUSD, 3),
            round(runMetrics.planner.pctStepsAffordableTwoEquity, 4),
            round(runMetrics.planner.pctStepsAffordableFullBasket, 4),
            round(runMetrics.risk.approvedBuyNotionalPctOfPlanned, 6)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), `${buildMemo(windowSummaries)}\n`);

  console.log(`Execution comparability summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('execution comparability experiment failed', error);
  process.exitCode = 1;
});
