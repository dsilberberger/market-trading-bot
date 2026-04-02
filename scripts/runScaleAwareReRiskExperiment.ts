import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'rerisk_accelerated';

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
  averageRealizedEquityAllocation: number;
  averageCoreCashPct: number;
  approvedBuyNotionalPctOfPlanned: number;
  riskOnSteps: number;
  lowEquityRiskOnSequenceCount: number;
  lowEquityRiskOnSequencesReachingPlus10Pct: number;
  lowEquityRiskOnSequencesReaching40Pct: number;
  lowEquityRiskOnSequencesStalledBelow40Pct: number;
  medianStepsToPlus10Pct: number | null;
  riskOnStepsWithCoreCashGte50Pct: number;
  averageRiskOnBuyBudgetUsd: number;
  reRiskAccelerationActiveSteps: number;
  averageReRiskSupplementUsd: number;
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: Array<{
    scale: number;
    baseline: VariantRunSummary;
    reriskAccelerated: VariantRunSummary;
    benchmarks: Array<{
      portfolio: string;
      totalReturnPct: number;
      maxDrawdownPct: number;
      endingValue: number;
      annualizedVolatilityPct: number | null;
    }>;
    delta: {
      averageRealizedEquityAllocation: number;
      averageCoreCashPct: number;
      strategyReturnPct: number;
      maxDrawdownPct: number;
      lowEquityRiskOnSequencesReachingPlus10Pct: number;
      lowEquityRiskOnSequencesReaching40Pct: number;
      lowEquityRiskOnSequencesStalledBelow40Pct: number;
      riskOnStepsWithCoreCashGte50Pct: number;
      averageRiskOnBuyBudgetUsd: number;
      reRiskAccelerationActiveSteps: number;
      averageReRiskSupplementUsd: number;
    };
  }>;
}

interface SequencePoint {
  date: string;
  regime: string | null;
  equityAllocationPct: number;
  coreCashPct: number;
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/rerisk_acceleration_scale_aware_experiment');
const SCALES = [2, 3];
const VARIANTS: VariantSpec[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    configPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'rerisk_accelerated',
    label: 'Risk-on sequence catch-up',
    configPath: path.join(ROOT, 'src/config/default.risk_on_sequence_catchup.position_size_scaled_risk_gate.json')
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
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
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

const computeEquityAllocationPct = (
  date: string,
  holdings: Array<{ symbol: string; quantity: number; avgPrice?: number }>,
  cash: number,
  closeMap: Map<string, Record<string, number>>,
  equitySet: Set<string>
) => {
  const closes = closeMap.get(String(date).slice(0, 10)) || {};
  let equityValue = 0;
  let totalValue = cash || 0;
  for (const holding of holdings || []) {
    const mark = closes[holding.symbol] ?? holding.avgPrice ?? 0;
    const marketValue = (holding.quantity || 0) * mark;
    totalValue += marketValue;
    if (equitySet.has(holding.symbol)) equityValue += marketValue;
  }
  return totalValue > 0 ? equityValue / totalValue : 0;
};

const buildScaledConfig = (variant: VariantSpec, scale: number) => {
  const base = readJson<BotConfig>(variant.configPath);
  return {
    ...base,
    startingCapitalUSD: base.startingCapitalUSD * scale
  } as BotConfig;
};

const analyzeRiskOnSequences = (
  result: HistoricalReplayResult,
  bundle: HistoricalReplayInput,
  exposureGroups: ExposureGroups
) => {
  const closeMap = buildCloseMap(bundle);
  const equitySet = buildEquitySet(exposureGroups);
  const points: SequencePoint[] = result.steps.map((step) => ({
    date: step.date,
    regime: step.regime,
    equityAllocationPct: computeEquityAllocationPct(
      step.date,
      step.holdingsAfterExecution.holdings || [],
      step.holdingsAfterExecution.cash || 0,
      closeMap,
      equitySet
    ),
    coreCashPct:
      step.capitalLanes?.coreCapitalUsd > 0 ? (step.capitalLanes.coreCashUsd || 0) / step.capitalLanes.coreCapitalUsd : 0
  }));

  const lowEntryThreshold = 0.35;
  const recoveryThreshold = 0.4;
  const sequences: SequencePoint[][] = [];
  let active: SequencePoint[] = [];

  for (const point of points) {
    if (point.regime === 'risk_on') {
      active.push(point);
    } else if (active.length) {
      sequences.push(active);
      active = [];
    }
  }
  if (active.length) sequences.push(active);

  const lowEntrySequences = sequences.filter((sequence) => (sequence[0]?.equityAllocationPct ?? 1) < lowEntryThreshold);
  const stepsToPlus10: number[] = [];
  let lowEquityRiskOnSequencesReachingPlus10Pct = 0;
  let lowEquityRiskOnSequencesReaching40Pct = 0;
  let lowEquityRiskOnSequencesStalledBelow40Pct = 0;

  for (const sequence of lowEntrySequences) {
    const entryEquity = sequence[0]?.equityAllocationPct ?? 0;
    const plus10Index = sequence.findIndex((point) => point.equityAllocationPct >= entryEquity + 0.10);
    if (plus10Index >= 0) {
      lowEquityRiskOnSequencesReachingPlus10Pct += 1;
      stepsToPlus10.push(plus10Index);
    }
    if (sequence.some((point) => point.equityAllocationPct >= recoveryThreshold)) {
      lowEquityRiskOnSequencesReaching40Pct += 1;
    } else if (sequence.length >= 3) {
      lowEquityRiskOnSequencesStalledBelow40Pct += 1;
    }
  }

  return {
    lowEquityRiskOnSequenceCount: lowEntrySequences.length,
    lowEquityRiskOnSequencesReachingPlus10Pct,
    lowEquityRiskOnSequencesReaching40Pct,
    lowEquityRiskOnSequencesStalledBelow40Pct,
    medianStepsToPlus10Pct: median(stepsToPlus10),
    riskOnStepsWithCoreCashGte50Pct: points.filter((point) => point.regime === 'risk_on' && point.coreCashPct >= 0.5).length
  };
};

const summarizeRun = (
  result: HistoricalReplayResult,
  bundle: HistoricalReplayInput,
  exposureGroups: ExposureGroups
): VariantRunSummary => {
  const validation = readJson<any>(path.join(result.outputDir, 'validation_summary.json'));
  const strategy = validation.portfolios.find((entry: any) => entry.type === 'strategy');

  let plannedBuyNotional = 0;
  let approvedBuyNotional = 0;
  let riskOnSteps = 0;
  const riskOnBuyBudgets: number[] = [];
  const reRiskSupplements: number[] = [];
  let reRiskAccelerationActiveSteps = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const budgetEnforcement = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    const riskReport = readJson<any>(path.join(runDir, 'risk_report.json'));
    const deploy = readJson<any>(path.join(runDir, 'capital_deployment.json'));

    const plannedStepBuyNotional = Number(budgetEnforcement?.etf?.plannedBuyUsd || 0);
    const approvedStepBuyNotional = Array.isArray(riskReport?.approvedOrders)
      ? riskReport.approvedOrders
          .filter((order: any) => order.side === 'BUY')
          .reduce((sum: number, order: any) => sum + Number(order.notionalUSD || 0), 0)
      : 0;

    plannedBuyNotional += plannedStepBuyNotional;
    approvedBuyNotional += approvedStepBuyNotional;

    if (deploy?.basis?.equityRegimeLabel !== 'risk_on') continue;
    riskOnSteps += 1;
    riskOnBuyBudgets.push(Number(deploy.buyBudgetUSD || 0));
    const supplementUsd = Number(deploy?.reRiskAcceleration?.supplementUsd || 0);
    reRiskSupplements.push(supplementUsd);
    if (deploy?.reRiskAcceleration?.active) reRiskAccelerationActiveSteps += 1;
  }

  const sequenceSummary = analyzeRiskOnSequences(result, bundle, exposureGroups);
  const closeMap = buildCloseMap(bundle);
  const equitySet = buildEquitySet(exposureGroups);
  const averageRealizedEquityAllocation = average(
    result.holdingsHistory.map((step) =>
      computeEquityAllocationPct(step.date, step.holdings || [], step.cash || 0, closeMap, equitySet)
    )
  );

  return {
    scale: 1,
    outputDir: result.outputDir,
    configPath: '',
    strategyReturnPct: strategy.totalReturnPct,
    maxDrawdownPct: strategy.maxDrawdownPct,
    endingValue: strategy.endingValue,
    annualizedVolatilityPct: strategy.annualizedVolatilityPct ?? null,
    averageRealizedEquityAllocation: round(averageRealizedEquityAllocation),
    averageCoreCashPct: round(validation.strategy?.coreLaneMetrics?.averageCoreCashPct ?? 0),
    approvedBuyNotionalPctOfPlanned: round(approvedBuyNotional / Math.max(plannedBuyNotional, 1e-9), 6),
    riskOnSteps,
    lowEquityRiskOnSequenceCount: sequenceSummary.lowEquityRiskOnSequenceCount,
    lowEquityRiskOnSequencesReachingPlus10Pct: sequenceSummary.lowEquityRiskOnSequencesReachingPlus10Pct,
    lowEquityRiskOnSequencesReaching40Pct: sequenceSummary.lowEquityRiskOnSequencesReaching40Pct,
    lowEquityRiskOnSequencesStalledBelow40Pct: sequenceSummary.lowEquityRiskOnSequencesStalledBelow40Pct,
    medianStepsToPlus10Pct: sequenceSummary.medianStepsToPlus10Pct,
    riskOnStepsWithCoreCashGte50Pct: sequenceSummary.riskOnStepsWithCoreCashGte50Pct,
    averageRiskOnBuyBudgetUsd: round(average(riskOnBuyBudgets)),
    reRiskAccelerationActiveSteps,
    averageReRiskSupplementUsd: round(average(reRiskSupplements))
  };
};

const buildMemo = (windows: WindowSummary[]) => {
  const lines: string[] = ['# Sequence-Aware Re-Risk Acceleration Memo', ''];

  for (const window of windows) {
    lines.push(`## ${window.windowLabel}`);
    for (const scaleSummary of window.scales) {
      const baseline6040 = scaleSummary.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');
      lines.push(`### ${scaleSummary.scale}x`);
      lines.push(
        `Low-entry risk_on sequences reaching +10 equity points moved ${scaleSummary.baseline.lowEquityRiskOnSequencesReachingPlus10Pct}/${scaleSummary.baseline.lowEquityRiskOnSequenceCount} -> ${scaleSummary.reriskAccelerated.lowEquityRiskOnSequencesReachingPlus10Pct}/${scaleSummary.reriskAccelerated.lowEquityRiskOnSequenceCount}, and sequences reaching 40% equity moved ${scaleSummary.baseline.lowEquityRiskOnSequencesReaching40Pct} -> ${scaleSummary.reriskAccelerated.lowEquityRiskOnSequencesReaching40Pct}.`
      );
      lines.push(
        `Average realized equity moved ${(scaleSummary.baseline.averageRealizedEquityAllocation * 100).toFixed(2)}% -> ${(scaleSummary.reriskAccelerated.averageRealizedEquityAllocation * 100).toFixed(2)}%, while risk_on steps with core cash >= 50% moved ${scaleSummary.baseline.riskOnStepsWithCoreCashGte50Pct} -> ${scaleSummary.reriskAccelerated.riskOnStepsWithCoreCashGte50Pct}.`
      );
      lines.push(
        `Average risk_on buy budget moved $${scaleSummary.baseline.averageRiskOnBuyBudgetUsd.toFixed(2)} -> $${scaleSummary.reriskAccelerated.averageRiskOnBuyBudgetUsd.toFixed(2)} with active catch-up on ${scaleSummary.reriskAccelerated.reRiskAccelerationActiveSteps} steps.`
      );
      lines.push(
        `Return moved ${(scaleSummary.baseline.strategyReturnPct * 100).toFixed(2)}% -> ${(scaleSummary.reriskAccelerated.strategyReturnPct * 100).toFixed(2)}% with max drawdown ${(scaleSummary.baseline.maxDrawdownPct * 100).toFixed(2)}% -> ${(scaleSummary.reriskAccelerated.maxDrawdownPct * 100).toFixed(2)}%.`
      );
      if (baseline6040) {
        lines.push(
          `Variant versus 60/40 remains ${(scaleSummary.reriskAccelerated.strategyReturnPct * 100).toFixed(2)}% vs ${(baseline6040.totalReturnPct * 100).toFixed(2)}%.`
        );
      }
      lines.push('');
    }
  }

  lines.push('## Recommendation');
  lines.push(
    'If a bounded sequence-aware catch-up improves low-entry favorable-state rebuild and average realized equity more than the earlier regime/deploy/cap experiments, then slow multi-step re-risking is the main remaining bottleneck.'
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
          runPrefix: `replay-rerisk-${window.key}-${variant.key}-scale${scale}x`,
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
        reriskAccelerated: results.rerisk_accelerated,
        benchmarks,
        delta: {
          averageRealizedEquityAllocation: round(
            results.rerisk_accelerated.averageRealizedEquityAllocation - results.baseline.averageRealizedEquityAllocation
          ),
          averageCoreCashPct: round(results.rerisk_accelerated.averageCoreCashPct - results.baseline.averageCoreCashPct),
          strategyReturnPct: round(results.rerisk_accelerated.strategyReturnPct - results.baseline.strategyReturnPct),
          maxDrawdownPct: round(results.rerisk_accelerated.maxDrawdownPct - results.baseline.maxDrawdownPct),
          lowEquityRiskOnSequencesReachingPlus10Pct:
            results.rerisk_accelerated.lowEquityRiskOnSequencesReachingPlus10Pct -
            results.baseline.lowEquityRiskOnSequencesReachingPlus10Pct,
          lowEquityRiskOnSequencesReaching40Pct:
            results.rerisk_accelerated.lowEquityRiskOnSequencesReaching40Pct -
            results.baseline.lowEquityRiskOnSequencesReaching40Pct,
          lowEquityRiskOnSequencesStalledBelow40Pct:
            results.rerisk_accelerated.lowEquityRiskOnSequencesStalledBelow40Pct -
            results.baseline.lowEquityRiskOnSequencesStalledBelow40Pct,
          riskOnStepsWithCoreCashGte50Pct:
            results.rerisk_accelerated.riskOnStepsWithCoreCashGte50Pct -
            results.baseline.riskOnStepsWithCoreCashGte50Pct,
          averageRiskOnBuyBudgetUsd: round(
            results.rerisk_accelerated.averageRiskOnBuyBudgetUsd - results.baseline.averageRiskOnBuyBudgetUsd
          ),
          reRiskAccelerationActiveSteps:
            results.rerisk_accelerated.reRiskAccelerationActiveSteps - results.baseline.reRiskAccelerationActiveSteps,
          averageReRiskSupplementUsd: round(
            results.rerisk_accelerated.averageReRiskSupplementUsd - results.baseline.averageReRiskSupplementUsd
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
    experiment: 'rerisk_acceleration_scale_aware',
    scales: SCALES,
    baselineConfig: path.relative(ROOT, VARIANTS[0].configPath),
    variantConfig: path.relative(ROOT, VARIANTS[1].configPath),
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,variant,avg_realized_equity_pct,avg_core_cash_pct,return_pct,max_drawdown_pct,low_entry_sequences,plus10_sequences,reached_40_sequences,stalled_below_40_sequences,median_steps_to_plus10,risk_on_core_cash_gte_50_steps,avg_risk_on_buy_budget_usd,rerisk_active_steps,avg_rerisk_supplement_usd,approved_buy_notional_pct_planned'
  ];
  for (const window of windowSummaries) {
    for (const scaleSummary of window.scales) {
      const rows: Array<[string, VariantRunSummary]> = [
        ['baseline', scaleSummary.baseline],
        ['rerisk_accelerated', scaleSummary.reriskAccelerated]
      ];
      for (const [variant, summary] of rows) {
        csvLines.push(
          [
            window.windowKey,
            String(scaleSummary.scale),
            variant,
            round(summary.averageRealizedEquityAllocation),
            round(summary.averageCoreCashPct),
            round(summary.strategyReturnPct),
            round(summary.maxDrawdownPct),
            String(summary.lowEquityRiskOnSequenceCount),
            String(summary.lowEquityRiskOnSequencesReachingPlus10Pct),
            String(summary.lowEquityRiskOnSequencesReaching40Pct),
            String(summary.lowEquityRiskOnSequencesStalledBelow40Pct),
            summary.medianStepsToPlus10Pct == null ? '' : String(summary.medianStepsToPlus10Pct),
            String(summary.riskOnStepsWithCoreCashGte50Pct),
            round(summary.averageRiskOnBuyBudgetUsd),
            String(summary.reRiskAccelerationActiveSteps),
            round(summary.averageReRiskSupplementUsd),
            round(summary.approvedBuyNotionalPctOfPlanned)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), buildMemo(windowSummaries));

  console.log(`Re-risk acceleration summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('re-risk acceleration scale-aware experiment failed', error);
  process.exitCode = 1;
});
