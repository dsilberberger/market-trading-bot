import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

interface ValidationWindow {
  key: string;
  label: string;
  classification: string;
  bundlePath: string;
}

interface BenchmarkSummary {
  portfolio: string;
  totalReturnPct: number;
  maxDrawdownPct: number;
  endingValue: number;
  annualizedVolatilityPct: number | null;
  recoveryDate?: string;
  recoveryBars?: number;
}

interface ScaleValidationSummary {
  scale: number;
  configPath: string;
  outputDir: string;
  strategy: {
    totalReturnPct: number;
    maxDrawdownPct: number;
    endingValue: number;
    annualizedVolatilityPct: number | null;
    tradeCount: number;
    averageRealizedEquityAllocation: number;
    successfulFillCount: number;
    noFillStepCount: number;
    brokerErrorCount: number;
  };
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
  benchmarks: BenchmarkSummary[];
}

interface WindowValidationSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: ScaleValidationSummary[];
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/scale_aware_validation');
const GENERATED_CONFIG_ROOT = path.join(OUTPUT_ROOT, 'generated_configs');
const BASE_CONFIG_PATH = path.join(ROOT, 'src/config/default.json');
const CORE_EQUITY = new Set(['VTI', 'VTV', 'USMV', 'VXUS']);
const SCALES = [1, 2, 3];

const WINDOWS: ValidationWindow[] = [
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
const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

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

const buildScaledConfig = (scale: number) => {
  const base = readJson<BotConfig>(BASE_CONFIG_PATH);
  const scaled: BotConfig = {
    ...base,
    startingCapitalUSD: base.startingCapitalUSD * scale
  };
  const configPath = path.join(GENERATED_CONFIG_ROOT, `promoted_working_baseline.scale_${scale}x.json`);
  writeJson(configPath, scaled);
  return configPath;
};

const summarizeScaleRun = (
  result: HistoricalReplayResult,
  bundle: HistoricalReplayInput,
  exposureGroups: ExposureGroups
): ScaleValidationSummary => {
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

  let successfulFillCount = 0;
  let noFillStepCount = 0;
  let brokerErrorCount = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const plan = readJson<any>(path.join(runDir, 'execution_plan.json'));
    const deploy = readJson<any>(path.join(runDir, 'capital_deployment.json'));
    const budgetEnforcement = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    const riskReport = readJson<any>(path.join(runDir, 'risk_report.json'));
    const fills = readJson<any[]>(path.join(runDir, 'fills.json'));

    const fillEvents = Array.isArray(fills) ? fills : [];
    const actualFills = fillEvents.filter((fill: any) => fill.orderId);
    successfulFillCount += actualFills.length;
    if (!actualFills.length) noFillStepCount += 1;
    brokerErrorCount += fillEvents.filter((fill: any) => String(fill.reason || '').toUpperCase().includes('BROKER')).length;

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

    const selectedSymbols = Array.isArray(plan.selectedSymbols) ? plan.selectedSymbols : [];
    const selectedCount = selectedSymbols.length;
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

    const omittedCore = targetSymbols.filter((symbol) => CORE_EQUITY.has(symbol) && !selectedSymbols.includes(symbol));
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

  const benchmarks = (validation.portfolios || [])
    .filter((entry: any) => entry.type === 'benchmark')
    .map((entry: any) => ({
      portfolio: entry.portfolio,
      totalReturnPct: entry.totalReturnPct,
      maxDrawdownPct: entry.maxDrawdownPct,
      endingValue: entry.endingValue,
      annualizedVolatilityPct: entry.annualizedVolatilityPct ?? null,
      recoveryDate: entry.recoveryDate,
      recoveryBars: entry.recoveryBars
    }));

  return {
    scale: 1,
    configPath: '',
    outputDir: result.outputDir,
    strategy: {
      totalReturnPct: strategy.totalReturnPct,
      maxDrawdownPct: strategy.maxDrawdownPct,
      endingValue: strategy.endingValue,
      annualizedVolatilityPct: strategy.annualizedVolatilityPct ?? null,
      tradeCount: strategy.tradeCount,
      averageRealizedEquityAllocation: round(computeAverageRealizedEquityAllocation(holdingsHistory, closeMap, equitySet)),
      successfulFillCount,
      noFillStepCount,
      brokerErrorCount
    },
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
    },
    benchmarks
  };
};

const buildMemo = (windows: WindowValidationSummary[]) => {
  const modern = windows.find((entry) => entry.windowKey.includes('nasdaq'));
  const adjusted = windows.find((entry) => entry.windowKey.includes('yahoo_adjusted'));
  if (!modern || !adjusted) return '';

  const modern1x = modern.scales.find((entry) => entry.scale === 1)!;
  const modern2x = modern.scales.find((entry) => entry.scale === 2)!;
  const modern3x = modern.scales.find((entry) => entry.scale === 3)!;
  const adjusted1x = adjusted.scales.find((entry) => entry.scale === 1)!;
  const adjusted2x = adjusted.scales.find((entry) => entry.scale === 2)!;
  const adjusted3x = adjusted.scales.find((entry) => entry.scale === 3)!;

  const formatPct = (value: number) => `${(value * 100).toFixed(2)}%`;
  const modern6040 = modern2x.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');
  const adjusted6040 = adjusted2x.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');

  return `# Scale-Aware Validation Memo

## A. Why 1x Is No Longer The Primary Lens
At 1x, the promoted working baseline is still heavily distorted by whole-share affordability. In the modern window, planner-unexecutable steps are ${modern1x.planner.plannerUnexecutableSteps} and omitted core-equity steps are ${modern1x.planner.omittedCoreEquitySteps}; by 3x those fall to ${modern3x.planner.plannerUnexecutableSteps} and ${modern3x.planner.omittedCoreEquitySteps}. That makes 1x a constrained implementation case, not the cleanest strategy-quality lens.

## B. Why 2x/3x Are The Preferred Lens
At 2x/3x, the same strategy logic runs with materially better execution comparability. The promoted baseline can afford a full target basket on ${(modern2x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% / ${(modern3x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% of positive-target steps in the modern window, versus ${(modern1x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% at 1x. In the adjusted window, full-basket affordability improves from ${(adjusted1x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% to ${(adjusted2x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}% to ${(adjusted3x.planner.pctStepsAffordableFullBasket * 100).toFixed(1)}%.

## C. What This Means For Current Confidence
The promoted working baseline should now be judged mainly through the 2x/3x lens. Under that lens, the modern window no longer looks dominated by planner pathology, and the adjusted window is materially less distorted than at 1x. The system still looks directionally conservative, but the earlier strongest claims about structural over-defensiveness need to be interpreted as partly execution-scale artifacts.

## D. Next Research Step
Pause more tuning work and expand broader validation under the scale-aware framework. The next useful discriminator is more execution-comparable validation windows, not more planner or cap/regime tuning.

## E. What Should Wait
Further planner tuning should wait. Further cap/regime tuning should also wait. Use 1x as an implementation-case reference, but treat 2x/3x as the primary judgment lens going forward.

## F. Current 2x Reference Check
At 2x, the promoted baseline returns ${formatPct(modern2x.strategy.totalReturnPct)} in the modern window versus ${modern6040 ? formatPct(modern6040.totalReturnPct) : 'n/a'} for 60/40, and ${formatPct(adjusted2x.strategy.totalReturnPct)} in the adjusted window versus ${adjusted6040 ? formatPct(adjusted6040.totalReturnPct) : 'n/a'} for 60/40. Those are still conservative outcomes, but they are now measured in a materially cleaner execution regime.`;
};

const run = async () => {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.mkdirSync(GENERATED_CONFIG_ROOT, { recursive: true });

  const exposureGroups = readJson<ExposureGroups>(path.join(ROOT, 'src/config/exposure_groups_small.json'));
  const windowSummaries: WindowValidationSummary[] = [];

  for (const window of WINDOWS) {
    const bundle = readJson<HistoricalReplayInput>(window.bundlePath);
    const scaleSummaries: ScaleValidationSummary[] = [];

    for (const scale of SCALES) {
      const configPath = buildScaledConfig(scale);
      const outputDir = path.join(OUTPUT_ROOT, window.key, `scale_${scale}x`);
      const runPrefix = `replay-scale-aware-${window.key}-scale${scale}x`;
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
      scaleSummaries.push(metrics);
    }

    windowSummaries.push({
      windowKey: window.key,
      windowLabel: window.label,
      classification: window.classification,
      scales: scaleSummaries
    });
  }

  const summaryPath = path.join(OUTPUT_ROOT, 'comparison_summary.json');
  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    framework: {
      primaryLens: '2x_3x_execution_comparable',
      secondaryLens: '1x_constrained_implementation_case'
    },
    baselineConfig: path.relative(ROOT, BASE_CONFIG_PATH),
    scales: SCALES,
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,strategy_return_pct,strategy_max_drawdown_pct,strategy_ending_value,avg_realized_equity,planner_unexecutable,omitted_core_equity_steps,planner_one_symbol,avg_leftover_cash,approved_buy_notional_pct_planned,successful_fill_count,broker_error_count,benchmark_60_40_return_pct,benchmark_80_20_return_pct,benchmark_100_equity_return_pct'
  ];

  for (const window of windowSummaries) {
    for (const runMetrics of window.scales) {
      const benchmark6040 = runMetrics.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');
      const benchmark8020 = runMetrics.benchmarks.find((entry) => entry.portfolio === '80/20 (VTI/BND)');
      const benchmark100 = runMetrics.benchmarks.find((entry) => entry.portfolio === '100% Equity (VTI/VXUS)');
      csvLines.push(
        [
          window.windowKey,
          String(runMetrics.scale),
          round(runMetrics.strategy.totalReturnPct),
          round(runMetrics.strategy.maxDrawdownPct),
          round(runMetrics.strategy.endingValue, 3),
          round(runMetrics.strategy.averageRealizedEquityAllocation),
          String(runMetrics.planner.plannerUnexecutableSteps),
          String(runMetrics.planner.omittedCoreEquitySteps),
          String(runMetrics.planner.plannerOneSymbolSteps),
          round(runMetrics.planner.averageLeftoverCashUSD, 3),
          round(runMetrics.risk.approvedBuyNotionalPctOfPlanned, 6),
          String(runMetrics.strategy.successfulFillCount),
          String(runMetrics.strategy.brokerErrorCount),
          benchmark6040 ? round(benchmark6040.totalReturnPct) : '',
          benchmark8020 ? round(benchmark8020.totalReturnPct) : '',
          benchmark100 ? round(benchmark100.totalReturnPct) : ''
        ].join(',')
      );
    }
  }

  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), `${buildMemo(windowSummaries)}\n`);

  console.log(`Scale-aware validation summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('scale-aware validation failed', error);
  process.exitCode = 1;
});
