import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'regime_eased';

interface VariantSpec {
  key: VariantKey;
  label: string;
  configPath: string;
}

interface ValidationWindow {
  key: string;
  label: string;
  classification: string;
  bundlePath: string;
}

interface VariantRunSummary {
  scale: number;
  outputDir: string;
  configPath: string;
  strategyReturnPct: number;
  maxDrawdownPct: number;
  endingValue: number;
  annualizedVolatilityPct: number | null;
  riskOnOccupancyPct: number;
  averageRealizedEquityAllocation: number;
  averageCoreCashPct: number;
  plannerUnexecutableSteps: number;
  approvedBuyNotionalPctOfPlanned: number;
  stepsWithRiskBlockedBuys: number;
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: Array<{
    scale: number;
    baseline: VariantRunSummary;
    regimeEased: VariantRunSummary;
    benchmarks: Array<{
      portfolio: string;
      totalReturnPct: number;
      maxDrawdownPct: number;
      endingValue: number;
      annualizedVolatilityPct: number | null;
    }>;
    delta: {
      riskOnOccupancyPct: number;
      averageRealizedEquityAllocation: number;
      averageCoreCashPct: number;
      strategyReturnPct: number;
      maxDrawdownPct: number;
      plannerUnexecutableSteps: number;
      approvedBuyNotionalPctOfPlanned: number;
    };
  }>;
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/regime_easing_scale_aware_experiment');
const SCALES = [2, 3];
const VARIANTS: VariantSpec[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    configPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'regime_eased',
    label: 'Recovery-friendly regime easing',
    configPath: path.join(ROOT, 'src/config/default.recovery_friendly_regime_gate.position_size_scaled_risk_gate.json')
  }
];
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

const buildScaledConfig = (variant: VariantSpec, scale: number) => {
  const base = readJson<BotConfig>(variant.configPath);
  return {
    ...base,
    startingCapitalUSD: base.startingCapitalUSD * scale
  } as BotConfig;
};

const summarizeRun = (
  result: HistoricalReplayResult,
  bundle: HistoricalReplayInput,
  exposureGroups: ExposureGroups
): VariantRunSummary => {
  const validation = readJson<any>(path.join(result.outputDir, 'validation_summary.json'));
  const holdingsHistory = readJson<any[]>(path.join(result.outputDir, 'holdings_history.json'));
  const closeMap = buildCloseMap(bundle);
  const equitySet = buildEquitySet(exposureGroups);
  const strategy = validation.portfolios.find((entry: any) => entry.type === 'strategy');

  let plannerUnexecutableSteps = 0;
  let plannedBuyNotional = 0;
  let approvedBuyNotional = 0;
  let stepsWithRiskBlockedBuys = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const plan = readJson<any>(path.join(runDir, 'execution_plan.json'));
    const budgetEnforcement = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    const riskReport = readJson<any>(path.join(runDir, 'risk_report.json'));

    if (plan.status === 'UNEXECUTABLE') plannerUnexecutableSteps += 1;

    const plannedStepBuyNotional = Number(budgetEnforcement?.etf?.plannedBuyUsd || 0);
    const approvedStepBuyNotional = Array.isArray(riskReport?.approvedOrders)
      ? riskReport.approvedOrders
          .filter((order: any) => order.side === 'BUY')
          .reduce((sum: number, order: any) => sum + Number(order.notionalUSD || 0), 0)
      : 0;

    plannedBuyNotional += plannedStepBuyNotional;
    approvedBuyNotional += approvedStepBuyNotional;
    if (plannedStepBuyNotional > 0 && approvedStepBuyNotional === 0) stepsWithRiskBlockedBuys += 1;
  }

  return {
    scale: 1,
    outputDir: result.outputDir,
    configPath: '',
    strategyReturnPct: strategy.totalReturnPct,
    maxDrawdownPct: strategy.maxDrawdownPct,
    endingValue: strategy.endingValue,
    annualizedVolatilityPct: strategy.annualizedVolatilityPct ?? null,
    riskOnOccupancyPct: validation.strategy?.regimeOccupancy?.percentages?.risk_on ?? 0,
    averageRealizedEquityAllocation: round(computeAverageRealizedEquityAllocation(holdingsHistory, closeMap, equitySet)),
    averageCoreCashPct: round(validation.strategy?.coreLaneMetrics?.averageCoreCashPct ?? 0),
    plannerUnexecutableSteps,
    approvedBuyNotionalPctOfPlanned: round(approvedBuyNotional / Math.max(plannedBuyNotional, 1e-9), 6),
    stepsWithRiskBlockedBuys
  };
};

const buildMemo = (windows: WindowSummary[]) => {
  const lines: string[] = ['# Regime Easing Scale-Aware Memo', ''];

  for (const window of windows) {
    lines.push(`## ${window.windowLabel}`);
    for (const scaleSummary of window.scales) {
      const baseline6040 = scaleSummary.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');
      lines.push(`### ${scaleSummary.scale}x`);
      lines.push(
        `Risk-on occupancy moved ${(scaleSummary.baseline.riskOnOccupancyPct * 100).toFixed(2)}% -> ${(scaleSummary.regimeEased.riskOnOccupancyPct * 100).toFixed(2)}%.`
      );
      lines.push(
        `Average realized equity moved ${(scaleSummary.baseline.averageRealizedEquityAllocation * 100).toFixed(2)}% -> ${(scaleSummary.regimeEased.averageRealizedEquityAllocation * 100).toFixed(2)}%, and average core cash moved ${(scaleSummary.baseline.averageCoreCashPct * 100).toFixed(2)}% -> ${(scaleSummary.regimeEased.averageCoreCashPct * 100).toFixed(2)}%.`
      );
      lines.push(
        `Return moved ${(scaleSummary.baseline.strategyReturnPct * 100).toFixed(2)}% -> ${(scaleSummary.regimeEased.strategyReturnPct * 100).toFixed(2)}% with max drawdown ${(scaleSummary.baseline.maxDrawdownPct * 100).toFixed(2)}% -> ${(scaleSummary.regimeEased.maxDrawdownPct * 100).toFixed(2)}%.`
      );
      if (baseline6040) {
        lines.push(
          `Baseline versus 60/40 remains ${(scaleSummary.regimeEased.strategyReturnPct * 100).toFixed(2)}% vs ${(baseline6040.totalReturnPct * 100).toFixed(2)}%.`
        );
      }
      lines.push('');
    }
  }

  lines.push('## Recommendation');
  lines.push(
    'If the regime-eased variant still leaves realized equity materially low and benchmark gaps large at 2x/3x, the system remains too defensive even after this upstream change.'
  );

  return `${lines.join('\n')}\n`;
};

const run = async () => {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const exposureGroups = readJson<ExposureGroups>(path.join(ROOT, 'src/config/exposure_groups_small.json'));
  const windowSummaries: WindowSummary[] = [];

  for (const window of WINDOWS) {
    const bundle = readJson<HistoricalReplayInput>(window.bundlePath);
    const scaleSummaries: WindowSummary['scales'] = [];

    for (const scale of SCALES) {
      const results = {} as Record<VariantKey, VariantRunSummary>;

      for (const variant of VARIANTS) {
        const outputDir = path.join(OUTPUT_ROOT, window.key, variant.key, `scale_${scale}x`);
        const config = buildScaledConfig(variant, scale);
        const generatedConfigPath = path.join(OUTPUT_ROOT, 'generated_configs', `${variant.key}.scale_${scale}x.json`);
        writeJson(generatedConfigPath, config);

        const result = await runHistoricalReplay({
          input: bundle,
          configPath: generatedConfigPath,
          outputDir,
          runPrefix: `replay-regime-easing-${window.key}-${variant.key}-scale${scale}x`,
          strategy: 'deterministic'
        });

        const summary = summarizeRun(result, bundle, exposureGroups);
        summary.scale = scale;
        summary.outputDir = outputDir;
        summary.configPath = path.relative(ROOT, generatedConfigPath);
        results[variant.key] = summary;
      }

      const validation = readJson<any>(path.join(results.baseline.outputDir, 'validation_summary.json'));
      const benchmarks = (validation.portfolios || [])
        .filter((entry: any) => entry.type === 'benchmark')
        .map((entry: any) => ({
          portfolio: entry.portfolio,
          totalReturnPct: entry.totalReturnPct,
          maxDrawdownPct: entry.maxDrawdownPct,
          endingValue: entry.endingValue,
          annualizedVolatilityPct: entry.annualizedVolatilityPct ?? null
        }));

      scaleSummaries.push({
        scale,
        baseline: results.baseline,
        regimeEased: results.regime_eased,
        benchmarks,
        delta: {
          riskOnOccupancyPct: round(results.regime_eased.riskOnOccupancyPct - results.baseline.riskOnOccupancyPct),
          averageRealizedEquityAllocation: round(
            results.regime_eased.averageRealizedEquityAllocation - results.baseline.averageRealizedEquityAllocation
          ),
          averageCoreCashPct: round(results.regime_eased.averageCoreCashPct - results.baseline.averageCoreCashPct),
          strategyReturnPct: round(results.regime_eased.strategyReturnPct - results.baseline.strategyReturnPct),
          maxDrawdownPct: round(results.regime_eased.maxDrawdownPct - results.baseline.maxDrawdownPct),
          plannerUnexecutableSteps: results.regime_eased.plannerUnexecutableSteps - results.baseline.plannerUnexecutableSteps,
          approvedBuyNotionalPctOfPlanned: round(
            results.regime_eased.approvedBuyNotionalPctOfPlanned - results.baseline.approvedBuyNotionalPctOfPlanned
          )
        }
      });
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
    experiment: 'regime_easing_scale_aware',
    scales: SCALES,
    baselineConfig: path.relative(ROOT, VARIANTS[0].configPath),
    variantConfig: path.relative(ROOT, VARIANTS[1].configPath),
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,variant,risk_on_occupancy_pct,avg_realized_equity_pct,avg_core_cash_pct,return_pct,max_drawdown_pct,planner_unexecutable,approved_buy_notional_pct_planned'
  ];
  for (const window of windowSummaries) {
    for (const scaleSummary of window.scales) {
      const rows: Array<[string, VariantRunSummary]> = [
        ['baseline', scaleSummary.baseline],
        ['regime_eased', scaleSummary.regimeEased]
      ];
      for (const [variant, summary] of rows) {
        csvLines.push(
          [
            window.windowKey,
            String(scaleSummary.scale),
            variant,
            round(summary.riskOnOccupancyPct),
            round(summary.averageRealizedEquityAllocation),
            round(summary.averageCoreCashPct),
            round(summary.strategyReturnPct),
            round(summary.maxDrawdownPct),
            String(summary.plannerUnexecutableSteps),
            round(summary.approvedBuyNotionalPctOfPlanned)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), buildMemo(windowSummaries));

  console.log(`Regime easing summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('regime easing scale-aware experiment failed', error);
  process.exitCode = 1;
});
