import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'exposure_state_incremental_delta_v1' | 'exposure_state_incremental_delta_v2';

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

interface SequencePoint {
  date: string;
  regime: string | null;
  equityAllocationPct: number;
  coreCashPct: number;
}

interface SequenceSummary {
  lowEquityRiskOnSequenceCount: number;
  lowEquityRiskOnSequencesReachingPlus10Pct: number;
  lowEquityRiskOnSequencesReaching40Pct: number;
  riskOnStepsWithCoreCashGte50Pct: number;
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
  averageRiskOnCoreCashPct: number;
  lowEquityRiskOnSequenceCount: number;
  lowEquityRiskOnSequencesReachingPlus10Pct: number;
  lowEquityRiskOnSequencesReaching40Pct: number;
  riskOnStepsWithCoreCashGte50Pct: number;
  positiveRequestedDeltaSteps: number;
  positiveRequestedDeltaNonPositiveRealizedSteps: number;
  positiveRequestedDeltaNegativeRealizedSteps: number;
  positiveRequestedDeltaPositiveExecutedSteps: number;
  controllerDeltaSellOrderViolationSteps: number;
  averageRequestedExposureDeltaUsd: number;
  averagePlannedDeltaBuyUsd: number;
  averageApprovedDeltaBuyUsd: number;
  averageExecutedDeltaBuyUsd: number;
  averageRealizedExposureDeltaUsd: number;
  averageMinimumExecutableDeltaUsd: number;
  realizedToRequestedExposureRatio: number;
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: Array<{
    scale: number;
    baseline: VariantRunSummary;
    v1: VariantRunSummary;
    v2: VariantRunSummary;
  }>;
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/exposure_state_incremental_delta_v2_scale_aware_experiment');
const SCALES = [2, 3];
const VARIANTS: VariantSpec[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    configPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'exposure_state_incremental_delta_v1',
    label: 'Incremental delta handoff v1',
    configPath: path.join(
      ROOT,
      'src/config/default.stateful_rerisk_corridor_v2.incremental_exposure_delta.position_size_scaled_risk_gate.json'
    )
  },
  {
    key: 'exposure_state_incremental_delta_v2',
    label: 'Incremental delta handoff v2',
    configPath: path.join(ROOT, 'src/config/default.incremental_exposure_delta_v2.json')
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
): SequenceSummary => {
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
    if (point.regime === 'risk_on') active.push(point);
    else if (active.length) {
      sequences.push(active);
      active = [];
    }
  }
  if (active.length) sequences.push(active);

  const lowEntrySequences = sequences.filter((sequence) => (sequence[0]?.equityAllocationPct ?? 1) < lowEntryThreshold);
  let sequencesReachingPlus10Pct = 0;
  let sequencesReaching40Pct = 0;
  for (const sequence of lowEntrySequences) {
    const entry = sequence[0]?.equityAllocationPct ?? 0;
    if (sequence.some((point) => point.equityAllocationPct >= entry + 0.1)) sequencesReachingPlus10Pct += 1;
    if (sequence.some((point) => point.equityAllocationPct >= recoveryThreshold)) sequencesReaching40Pct += 1;
  }

  return {
    lowEquityRiskOnSequenceCount: lowEntrySequences.length,
    lowEquityRiskOnSequencesReachingPlus10Pct: sequencesReachingPlus10Pct,
    lowEquityRiskOnSequencesReaching40Pct: sequencesReaching40Pct,
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
  const closeMap = buildCloseMap(bundle);
  const equitySet = buildEquitySet(exposureGroups);
  const riskOnCoreCashPcts: number[] = [];
  const requestedExposureDeltasUsd: number[] = [];
  const plannedDeltaBuysUsd: number[] = [];
  const approvedDeltaBuysUsd: number[] = [];
  const executedDeltaBuysUsd: number[] = [];
  const realizedExposureDeltasUsd: number[] = [];
  const minimumExecutableDeltasUsd: number[] = [];
  let totalRequestedExposureDeltaUsd = 0;
  let totalRealizedExposureDeltaUsd = 0;
  let positiveRequestedDeltaSteps = 0;
  let positiveRequestedDeltaNonPositiveRealizedSteps = 0;
  let positiveRequestedDeltaNegativeRealizedSteps = 0;
  let positiveRequestedDeltaPositiveExecutedSteps = 0;
  let controllerDeltaSellOrderViolationSteps = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const deploy = readJson<any>(path.join(runDir, 'capital_deployment.json'));
    const exposureState = readJson<any>(path.join(runDir, 'exposure_state.json'));

    if (deploy?.basis?.equityRegimeLabel === 'risk_on' && step.capitalLanes?.coreCapitalUsd > 0) {
      riskOnCoreCashPcts.push((step.capitalLanes.coreCashUsd || 0) / step.capitalLanes.coreCapitalUsd);
    }

    const requested = Number(exposureState?.controllerOutputs?.requestedExposureDeltaUsd || 0);
    const planned = Number(exposureState?.implementationPlan?.plannedDeltaBuyUsd || 0);
    const approved = Number(exposureState?.riskOutcome?.approvedDeltaBuyUsd || 0);
    const executed = Number(exposureState?.executionOutcome?.executedDeltaBuyUsd || 0);
    const realized = Number(exposureState?.realizedOutcome?.realizedExposureDeltaUsd || 0);
    const minimumExecutable = Number(exposureState?.controllerOutputs?.minimumExecutableDeltaUsd || 0);
    requestedExposureDeltasUsd.push(requested);
    plannedDeltaBuysUsd.push(planned);
    approvedDeltaBuysUsd.push(approved);
    executedDeltaBuysUsd.push(executed);
    realizedExposureDeltasUsd.push(realized);
    minimumExecutableDeltasUsd.push(minimumExecutable);
    totalRequestedExposureDeltaUsd += Math.max(0, requested);
    totalRealizedExposureDeltaUsd += Math.max(0, realized);

    if (requested > 0) {
      positiveRequestedDeltaSteps += 1;
      if (realized <= 0) positiveRequestedDeltaNonPositiveRealizedSteps += 1;
      if (realized < 0) positiveRequestedDeltaNegativeRealizedSteps += 1;
      if (executed > 0) positiveRequestedDeltaPositiveExecutedSteps += 1;
    }
    if (Number(exposureState?.controllerDeltaSellOrdersCount || 0) > 0) {
      controllerDeltaSellOrderViolationSteps += 1;
    }
  }

  const sequenceSummary = analyzeRiskOnSequences(result, bundle, exposureGroups);
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
    averageRiskOnCoreCashPct: round(average(riskOnCoreCashPcts)),
    lowEquityRiskOnSequenceCount: sequenceSummary.lowEquityRiskOnSequenceCount,
    lowEquityRiskOnSequencesReachingPlus10Pct: sequenceSummary.lowEquityRiskOnSequencesReachingPlus10Pct,
    lowEquityRiskOnSequencesReaching40Pct: sequenceSummary.lowEquityRiskOnSequencesReaching40Pct,
    riskOnStepsWithCoreCashGte50Pct: sequenceSummary.riskOnStepsWithCoreCashGte50Pct,
    positiveRequestedDeltaSteps,
    positiveRequestedDeltaNonPositiveRealizedSteps,
    positiveRequestedDeltaNegativeRealizedSteps,
    positiveRequestedDeltaPositiveExecutedSteps,
    controllerDeltaSellOrderViolationSteps,
    averageRequestedExposureDeltaUsd: round(average(requestedExposureDeltasUsd)),
    averagePlannedDeltaBuyUsd: round(average(plannedDeltaBuysUsd)),
    averageApprovedDeltaBuyUsd: round(average(approvedDeltaBuysUsd)),
    averageExecutedDeltaBuyUsd: round(average(executedDeltaBuysUsd)),
    averageRealizedExposureDeltaUsd: round(average(realizedExposureDeltasUsd)),
    averageMinimumExecutableDeltaUsd: round(average(minimumExecutableDeltasUsd)),
    realizedToRequestedExposureRatio: round(totalRealizedExposureDeltaUsd / Math.max(totalRequestedExposureDeltaUsd, 1e-9))
  };
};

const buildMemo = (windows: WindowSummary[]) => {
  const lines: string[] = ['# Incremental Delta V2 Memo', ''];
  const allV2Runs = windows.flatMap((window) => window.scales.map((scale) => scale.v2));
  const allV1Runs = windows.flatMap((window) => window.scales.map((scale) => scale.v1));
  const totalPositiveRequested = allV2Runs.reduce((sum, run) => sum + run.positiveRequestedDeltaSteps, 0);
  const totalPositiveExecuted = allV2Runs.reduce((sum, run) => sum + run.positiveRequestedDeltaPositiveExecutedSteps, 0);
  const totalNegativeRealized = allV2Runs.reduce((sum, run) => sum + run.positiveRequestedDeltaNegativeRealizedSteps, 0);
  const totalSellViolations = allV2Runs.reduce((sum, run) => sum + run.controllerDeltaSellOrderViolationSteps, 0);

  for (const window of windows) {
    lines.push(`## ${window.windowLabel}`);
    for (const scaleSummary of window.scales) {
      const { baseline, v1, v2 } = scaleSummary;
      lines.push(`### ${scaleSummary.scale}x`);
      lines.push(
        `A. Positive-request steps converting into executed deltas: baseline ${baseline.positiveRequestedDeltaPositiveExecutedSteps}/${baseline.positiveRequestedDeltaSteps}, v1 ${v1.positiveRequestedDeltaPositiveExecutedSteps}/${v1.positiveRequestedDeltaSteps}, v2 ${v2.positiveRequestedDeltaPositiveExecutedSteps}/${v2.positiveRequestedDeltaSteps}.`
      );
      lines.push(
        `B. Negative realized delta on positive-request steps: v1 ${v1.positiveRequestedDeltaNegativeRealizedSteps}/${v1.positiveRequestedDeltaSteps}, v2 ${v2.positiveRequestedDeltaNegativeRealizedSteps}/${v2.positiveRequestedDeltaSteps}.`
      );
      lines.push(
        `C. Average requested/planned/executed delta buy USD: v1 $${v1.averageRequestedExposureDeltaUsd.toFixed(2)}/$${v1.averagePlannedDeltaBuyUsd.toFixed(2)}/$${v1.averageExecutedDeltaBuyUsd.toFixed(2)}, v2 $${v2.averageRequestedExposureDeltaUsd.toFixed(2)}/$${v2.averagePlannedDeltaBuyUsd.toFixed(2)}/$${v2.averageExecutedDeltaBuyUsd.toFixed(2)}.`
      );
      lines.push(
        `D. Average realized equity: baseline ${(baseline.averageRealizedEquityAllocation * 100).toFixed(2)}%, v1 ${(v1.averageRealizedEquityAllocation * 100).toFixed(2)}%, v2 ${(v2.averageRealizedEquityAllocation * 100).toFixed(2)}%.`
      );
      lines.push(
        `E. Low-equity rebuild reliability: plus10 baseline/v1/v2 = ${baseline.lowEquityRiskOnSequencesReachingPlus10Pct}/${v1.lowEquityRiskOnSequencesReachingPlus10Pct}/${v2.lowEquityRiskOnSequencesReachingPlus10Pct}; reached 40% = ${baseline.lowEquityRiskOnSequencesReaching40Pct}/${v1.lowEquityRiskOnSequencesReaching40Pct}/${v2.lowEquityRiskOnSequencesReaching40Pct}.`
      );
      lines.push(
        `F. Favorable-state cash: baseline ${(baseline.averageRiskOnCoreCashPct * 100).toFixed(2)}%, v1 ${(v1.averageRiskOnCoreCashPct * 100).toFixed(2)}%, v2 ${(v2.averageRiskOnCoreCashPct * 100).toFixed(2)}%.`
      );
      lines.push(
        `G. Return / max drawdown: baseline ${(baseline.strategyReturnPct * 100).toFixed(2)}% / ${(baseline.maxDrawdownPct * 100).toFixed(2)}%, v1 ${(v1.strategyReturnPct * 100).toFixed(2)}% / ${(v1.maxDrawdownPct * 100).toFixed(2)}%, v2 ${(v2.strategyReturnPct * 100).toFixed(2)}% / ${(v2.maxDrawdownPct * 100).toFixed(2)}%.`
      );
      lines.push('');
    }
  }

  const v2ImprovedExecutionRuns = windows.reduce(
    (sum, window) =>
      sum +
      window.scales.filter(
        (scale) =>
          scale.v2.positiveRequestedDeltaPositiveExecutedSteps > scale.v1.positiveRequestedDeltaPositiveExecutedSteps
      ).length,
    0
  );
  const v2ImprovedEquityRuns = windows.reduce(
    (sum, window) =>
      sum +
      window.scales.filter(
        (scale) => scale.v2.averageRealizedEquityAllocation > scale.v1.averageRealizedEquityAllocation
      ).length,
    0
  );
  const v2ImprovedCashRuns = windows.reduce(
    (sum, window) =>
      sum + window.scales.filter((scale) => scale.v2.averageRiskOnCoreCashPct < scale.v1.averageRiskOnCoreCashPct).length,
    0
  );
  const v2ReturnWins = windows.reduce(
    (sum, window) =>
      sum + window.scales.filter((scale) => scale.v2.strategyReturnPct > scale.v1.strategyReturnPct).length,
    0
  );
  const v2DrawdownWorsenedRuns = windows.reduce(
    (sum, window) =>
      sum + window.scales.filter((scale) => scale.v2.maxDrawdownPct > scale.v1.maxDrawdownPct + 1e-9).length,
    0
  );

  lines.push('## Recommendation');
  lines.push(
    `V2 fixed the minimum executable trade-size bottleneck materially if and only if positive-request steps converted into executed deltas without reintroducing sells. Aggregate v2 results were ${totalPositiveExecuted}/${totalPositiveRequested} positive-request steps with non-zero executed delta, ${totalNegativeRealized}/${totalPositiveRequested} negative realized deltas on positive-request steps, and ${totalSellViolations} controller-delta sell-order violations.`
  );
  lines.push(
    `Across the four scale/window runs, v2 improved executed conversion versus v1 in ${v2ImprovedExecutionRuns}/4 runs, improved average realized equity in ${v2ImprovedEquityRuns}/4 runs, reduced favorable-state cash in ${v2ImprovedCashRuns}/4 runs, improved return in ${v2ReturnWins}/4 runs, and worsened drawdown in ${v2DrawdownWorsenedRuns}/4 runs.`
  );
  lines.push(
    'Use the per-run table above to decide whether v2 solved the conversion bottleneck enough to keep advancing the Two-Layer direction or whether controller jump sizing and delta execution still need another bounded revision.'
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
          runPrefix: `replay-exposure-state-delta-v2-${window.key}-${variant.key}-scale${scale}x`,
          strategy: 'deterministic'
        });

        const summary = summarizeRun(result, bundle, exposureGroups);
        summary.scale = scale;
        summary.outputDir = outputDir;
        summary.configPath = path.relative(ROOT, generatedConfigPath);
        results[variant.key] = summary;
      }

      scaleSummaries.push({
        scale,
        baseline: results.baseline,
        v1: results.exposure_state_incremental_delta_v1,
        v2: results.exposure_state_incremental_delta_v2
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
    experiment: 'exposure_state_incremental_delta_v2_scale_aware',
    scales: SCALES,
    baselineConfig: path.relative(ROOT, VARIANTS[0].configPath),
    v1Config: path.relative(ROOT, VARIANTS[1].configPath),
    v2Config: path.relative(ROOT, VARIANTS[2].configPath),
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,variant,avg_realized_equity_pct,avg_risk_on_core_cash_pct,return_pct,max_drawdown_pct,low_entry_sequences,plus10_sequences,reached_40_sequences,risk_on_core_cash_gte_50_steps,positive_requested_delta_steps,positive_requested_delta_non_positive_realized_steps,positive_requested_delta_negative_realized_steps,positive_requested_delta_positive_executed_steps,controller_delta_sell_order_violations,avg_requested_exposure_delta_usd,avg_planned_delta_buy_usd,avg_approved_delta_buy_usd,avg_executed_delta_buy_usd,avg_realized_exposure_delta_usd,avg_minimum_executable_delta_usd,realized_to_requested_ratio'
  ];
  for (const window of windowSummaries) {
    for (const scaleSummary of window.scales) {
      for (const [variant, summary] of [
        ['baseline', scaleSummary.baseline],
        ['v1', scaleSummary.v1],
        ['v2', scaleSummary.v2]
      ] as const) {
        csvLines.push(
          [
            window.windowKey,
            String(scaleSummary.scale),
            variant,
            round(summary.averageRealizedEquityAllocation),
            round(summary.averageRiskOnCoreCashPct),
            round(summary.strategyReturnPct),
            round(summary.maxDrawdownPct),
            String(summary.lowEquityRiskOnSequenceCount),
            String(summary.lowEquityRiskOnSequencesReachingPlus10Pct),
            String(summary.lowEquityRiskOnSequencesReaching40Pct),
            String(summary.riskOnStepsWithCoreCashGte50Pct),
            String(summary.positiveRequestedDeltaSteps),
            String(summary.positiveRequestedDeltaNonPositiveRealizedSteps),
            String(summary.positiveRequestedDeltaNegativeRealizedSteps),
            String(summary.positiveRequestedDeltaPositiveExecutedSteps),
            String(summary.controllerDeltaSellOrderViolationSteps),
            round(summary.averageRequestedExposureDeltaUsd),
            round(summary.averagePlannedDeltaBuyUsd),
            round(summary.averageApprovedDeltaBuyUsd),
            round(summary.averageExecutedDeltaBuyUsd),
            round(summary.averageRealizedExposureDeltaUsd),
            round(summary.averageMinimumExecutableDeltaUsd),
            round(summary.realizedToRequestedExposureRatio)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), buildMemo(windowSummaries));

  console.log(`Exposure-state delta-v2 summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('exposure-state delta-v2 experiment failed', error);
  process.exitCode = 1;
});
