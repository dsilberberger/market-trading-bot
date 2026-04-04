import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'exposure_state_failed' | 'exposure_state_incremental_delta';

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
  averageCoreCashPct: number;
  averageRiskOnCoreCashPct: number;
  approvedBuyNotionalPctOfPlanned: number;
  riskOnSteps: number;
  lowEquityRiskOnSequenceCount: number;
  lowEquityRiskOnSequencesReachingPlus10Pct: number;
  lowEquityRiskOnSequencesReaching40Pct: number;
  riskOnStepsWithCoreCashGte50Pct: number;
  averageRiskOnBuyBudgetUsd: number;
  activeExposureStateSteps: number;
  controllerEntryCount: number;
  controllerAdvanceCount: number;
  controllerHoldCount: number;
  controllerPauseCount: number;
  controllerExitCount: number;
  averageTargetCoreEquityPct: number;
  averageRequestedExposureDeltaUsd: number;
  averageRealizedExposureDeltaUsd: number;
  averageShortfallUsd: number;
  realizedToRequestedExposureRatio: number;
  positiveRequestedDeltaSteps: number;
  positiveRequestedDeltaNonPositiveRealizedSteps: number;
  positiveRequestedDeltaNegativeRealizedSteps: number;
  controllerDeltaSellOrderViolationSteps: number;
  averagePlannedDeltaBuyUsd: number;
  averageApprovedDeltaBuyUsd: number;
  averageExecutedDeltaBuyUsd: number;
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: Array<{
    scale: number;
    baseline: VariantRunSummary;
    exposureStateFailed: VariantRunSummary;
    exposureStateIncrementalDelta: VariantRunSummary;
    benchmarks: Array<{
      portfolio: string;
      totalReturnPct: number;
      maxDrawdownPct: number;
      endingValue: number;
      annualizedVolatilityPct: number | null;
    }>;
    delta: {
      averageRealizedEquityAllocation: number;
      averageRiskOnCoreCashPct: number;
      strategyReturnPct: number;
      maxDrawdownPct: number;
      lowEquityRiskOnSequencesReachingPlus10Pct: number;
      lowEquityRiskOnSequencesReaching40Pct: number;
      riskOnStepsWithCoreCashGte50Pct: number;
      averageRequestedExposureDeltaUsd: number;
      averageRealizedExposureDeltaUsd: number;
      averageShortfallUsd: number;
      realizedToRequestedExposureRatio: number;
    };
  }>;
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/exposure_state_incremental_delta_scale_aware_experiment');
const SCALES = [2, 3];
const VARIANTS: VariantSpec[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    configPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'exposure_state_failed',
    label: 'Two-layer exposure state controller (failed first pass)',
    configPath: path.join(ROOT, 'src/config/default.stateful_rerisk_corridor_v2.position_size_scaled_risk_gate.json')
  },
  {
    key: 'exposure_state_incremental_delta',
    label: 'Two-layer exposure state controller (incremental delta handoff)',
    configPath: path.join(
      ROOT,
      'src/config/default.stateful_rerisk_corridor_v2.incremental_exposure_delta.position_size_scaled_risk_gate.json'
    )
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

  let plannedBuyNotional = 0;
  let approvedBuyNotional = 0;
  let riskOnSteps = 0;
  const riskOnBuyBudgets: number[] = [];
  const riskOnCoreCashPcts: number[] = [];
  const targetCoreEquityPcts: number[] = [];
  const requestedExposureDeltasUsd: number[] = [];
  const realizedExposureDeltasUsd: number[] = [];
  const shortfallsUsd: number[] = [];
  const plannedDeltaBuysUsd: number[] = [];
  const approvedDeltaBuysUsd: number[] = [];
  const executedDeltaBuysUsd: number[] = [];
  let totalRequestedExposureDeltaUsd = 0;
  let totalRealizedExposureDeltaUsd = 0;
  let activeExposureStateSteps = 0;
  let controllerEntryCount = 0;
  let controllerAdvanceCount = 0;
  let controllerHoldCount = 0;
  let controllerPauseCount = 0;
  let controllerExitCount = 0;
  let positiveRequestedDeltaSteps = 0;
  let positiveRequestedDeltaNonPositiveRealizedSteps = 0;
  let positiveRequestedDeltaNegativeRealizedSteps = 0;
  let controllerDeltaSellOrderViolationSteps = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const budgetEnforcement = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    const riskReport = readJson<any>(path.join(runDir, 'risk_report.json'));
    const deploy = readJson<any>(path.join(runDir, 'capital_deployment.json'));
    const exposureState = readJson<any>(path.join(runDir, 'exposure_state.json'));

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
    if (step.capitalLanes?.coreCapitalUsd > 0) {
      riskOnCoreCashPcts.push((step.capitalLanes.coreCashUsd || 0) / step.capitalLanes.coreCapitalUsd);
    }

    if (exposureState?.controllerOutputs?.active) activeExposureStateSteps += 1;
    const action = exposureState?.controllerOutputs?.controllerAction;
    if (action === 'entry') controllerEntryCount += 1;
    if (action === 'advance') controllerAdvanceCount += 1;
    if (action === 'hold') controllerHoldCount += 1;
    if (action === 'pause') controllerPauseCount += 1;
    if (action === 'exit') controllerExitCount += 1;

    targetCoreEquityPcts.push(Number(exposureState?.controllerOutputs?.targetCoreEquityPct || 0));
    const requested = Number(exposureState?.controllerOutputs?.requestedExposureDeltaUsd || 0);
    const realized = Number(exposureState?.realizedOutcome?.realizedExposureDeltaUsd || 0);
    const shortfall = Number(exposureState?.realizedOutcome?.shortfallUsd || 0);
    const plannedDeltaBuyUsd = Number(exposureState?.implementationPlan?.plannedDeltaBuyUsd || 0);
    const approvedDeltaBuyUsd = Number(exposureState?.riskOutcome?.approvedDeltaBuyUsd || 0);
    const executedDeltaBuyUsd = Number(exposureState?.executionOutcome?.executedDeltaBuyUsd || 0);
    requestedExposureDeltasUsd.push(requested);
    realizedExposureDeltasUsd.push(realized);
    shortfallsUsd.push(shortfall);
    plannedDeltaBuysUsd.push(plannedDeltaBuyUsd);
    approvedDeltaBuysUsd.push(approvedDeltaBuyUsd);
    executedDeltaBuysUsd.push(executedDeltaBuyUsd);
    totalRequestedExposureDeltaUsd += Math.max(0, requested);
    totalRealizedExposureDeltaUsd += Math.max(0, realized);
    if (requested > 0) {
      positiveRequestedDeltaSteps += 1;
      if (realized <= 0) positiveRequestedDeltaNonPositiveRealizedSteps += 1;
      if (realized < 0) positiveRequestedDeltaNegativeRealizedSteps += 1;
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
    averageCoreCashPct: round(validation.strategy?.coreLaneMetrics?.averageCoreCashPct ?? 0),
    averageRiskOnCoreCashPct: round(average(riskOnCoreCashPcts)),
    approvedBuyNotionalPctOfPlanned: round(approvedBuyNotional / Math.max(plannedBuyNotional, 1e-9)),
    riskOnSteps,
    lowEquityRiskOnSequenceCount: sequenceSummary.lowEquityRiskOnSequenceCount,
    lowEquityRiskOnSequencesReachingPlus10Pct: sequenceSummary.lowEquityRiskOnSequencesReachingPlus10Pct,
    lowEquityRiskOnSequencesReaching40Pct: sequenceSummary.lowEquityRiskOnSequencesReaching40Pct,
    riskOnStepsWithCoreCashGte50Pct: sequenceSummary.riskOnStepsWithCoreCashGte50Pct,
    averageRiskOnBuyBudgetUsd: round(average(riskOnBuyBudgets)),
    activeExposureStateSteps,
    controllerEntryCount,
    controllerAdvanceCount,
    controllerHoldCount,
    controllerPauseCount,
    controllerExitCount,
    averageTargetCoreEquityPct: round(average(targetCoreEquityPcts)),
    averageRequestedExposureDeltaUsd: round(average(requestedExposureDeltasUsd)),
    averageRealizedExposureDeltaUsd: round(average(realizedExposureDeltasUsd)),
    averageShortfallUsd: round(average(shortfallsUsd)),
    realizedToRequestedExposureRatio: round(totalRealizedExposureDeltaUsd / Math.max(totalRequestedExposureDeltaUsd, 1e-9)),
    positiveRequestedDeltaSteps,
    positiveRequestedDeltaNonPositiveRealizedSteps,
    positiveRequestedDeltaNegativeRealizedSteps,
    controllerDeltaSellOrderViolationSteps,
    averagePlannedDeltaBuyUsd: round(average(plannedDeltaBuysUsd)),
    averageApprovedDeltaBuyUsd: round(average(approvedDeltaBuysUsd)),
    averageExecutedDeltaBuyUsd: round(average(executedDeltaBuysUsd))
  };
};

const buildMemo = (windows: WindowSummary[]) => {
  const lines: string[] = ['# Incremental Delta Exposure State Memo', ''];
  const allCorrectedRuns = windows.flatMap((window) => window.scales.map((scale) => scale.exposureStateIncrementalDelta));
  const allFailedRuns = windows.flatMap((window) => window.scales.map((scale) => scale.exposureStateFailed));
  const semanticNegativeSteps = allCorrectedRuns.reduce(
    (sum, run) => sum + run.positiveRequestedDeltaNegativeRealizedSteps,
    0
  );
  const semanticPositiveSteps = allCorrectedRuns.reduce((sum, run) => sum + run.positiveRequestedDeltaSteps, 0);
  const semanticViolationSteps = allCorrectedRuns.reduce((sum, run) => sum + run.controllerDeltaSellOrderViolationSteps, 0);
  const correctedNonPositiveSteps = allCorrectedRuns.reduce(
    (sum, run) => sum + run.positiveRequestedDeltaNonPositiveRealizedSteps,
    0
  );
  const improvedVsFailedEquityRuns = windows.reduce(
    (sum, window) =>
      sum +
      window.scales.filter(
        (scale) =>
          scale.exposureStateIncrementalDelta.averageRealizedEquityAllocation >
          scale.exposureStateFailed.averageRealizedEquityAllocation
      ).length,
    0
  );
  const improvedVsFailedCashRuns = windows.reduce(
    (sum, window) =>
      sum +
      window.scales.filter(
        (scale) =>
          scale.exposureStateIncrementalDelta.averageRiskOnCoreCashPct <
          scale.exposureStateFailed.averageRiskOnCoreCashPct
      ).length,
    0
  );
  const improvedVsBaselineEquityRuns = windows.reduce(
    (sum, window) =>
      sum +
      window.scales.filter(
        (scale) =>
          scale.exposureStateIncrementalDelta.averageRealizedEquityAllocation >
          scale.baseline.averageRealizedEquityAllocation
      ).length,
    0
  );
  const correctedRebuildWins = windows.reduce(
    (sum, window) =>
      sum +
      window.scales.filter(
        (scale) =>
          scale.exposureStateIncrementalDelta.lowEquityRiskOnSequencesReachingPlus10Pct >
            scale.exposureStateFailed.lowEquityRiskOnSequencesReachingPlus10Pct ||
          scale.exposureStateIncrementalDelta.lowEquityRiskOnSequencesReaching40Pct >
            scale.exposureStateFailed.lowEquityRiskOnSequencesReaching40Pct
      ).length,
    0
  );
  const averagePlannedDeltaBuyUsd = average(allCorrectedRuns.map((run) => run.averagePlannedDeltaBuyUsd));
  const averageExecutedDeltaBuyUsd = average(allCorrectedRuns.map((run) => run.averageExecutedDeltaBuyUsd));
  const semanticFixAchieved = semanticNegativeSteps === 0 && semanticViolationSteps === 0;
  const economicRescueAchieved =
    improvedVsFailedEquityRuns === allCorrectedRuns.length &&
    improvedVsFailedCashRuns === allCorrectedRuns.length &&
    improvedVsBaselineEquityRuns === allCorrectedRuns.length &&
    correctedRebuildWins === allCorrectedRuns.length;

  for (const window of windows) {
    lines.push(`## ${window.windowLabel}`);
    for (const scaleSummary of window.scales) {
      const failed = scaleSummary.exposureStateFailed;
      const corrected = scaleSummary.exposureStateIncrementalDelta;
      lines.push(`### ${scaleSummary.scale}x`);
      lines.push(
        `A. Negative realized delta on positive-request steps: failed ${failed.positiveRequestedDeltaNegativeRealizedSteps}/${failed.positiveRequestedDeltaSteps}, corrected ${corrected.positiveRequestedDeltaNegativeRealizedSteps}/${corrected.positiveRequestedDeltaSteps}.`
      );
      lines.push(
        `B. Requested vs realized conversion: failed avg requested/realized $${failed.averageRequestedExposureDeltaUsd.toFixed(2)}/$${failed.averageRealizedExposureDeltaUsd.toFixed(2)} with ratio ${failed.realizedToRequestedExposureRatio.toFixed(3)}; corrected $${corrected.averageRequestedExposureDeltaUsd.toFixed(2)}/$${corrected.averageRealizedExposureDeltaUsd.toFixed(2)} with ratio ${corrected.realizedToRequestedExposureRatio.toFixed(3)}.`
      );
      lines.push(
        `C. Average realized equity: baseline ${(scaleSummary.baseline.averageRealizedEquityAllocation * 100).toFixed(2)}%, failed ${(failed.averageRealizedEquityAllocation * 100).toFixed(2)}%, corrected ${(corrected.averageRealizedEquityAllocation * 100).toFixed(2)}%.`
      );
      lines.push(
        `D. Favorable-state cash: baseline ${(scaleSummary.baseline.averageRiskOnCoreCashPct * 100).toFixed(2)}%, failed ${(failed.averageRiskOnCoreCashPct * 100).toFixed(2)}%, corrected ${(corrected.averageRiskOnCoreCashPct * 100).toFixed(2)}%; risk_on steps with core cash >= 50% = ${scaleSummary.baseline.riskOnStepsWithCoreCashGte50Pct}/${failed.riskOnStepsWithCoreCashGte50Pct}/${corrected.riskOnStepsWithCoreCashGte50Pct}.`
      );
      lines.push(
        `E. Return / max drawdown: baseline ${(scaleSummary.baseline.strategyReturnPct * 100).toFixed(2)}% / ${(scaleSummary.baseline.maxDrawdownPct * 100).toFixed(2)}%, failed ${(failed.strategyReturnPct * 100).toFixed(2)}% / ${(failed.maxDrawdownPct * 100).toFixed(2)}%, corrected ${(corrected.strategyReturnPct * 100).toFixed(2)}% / ${(corrected.maxDrawdownPct * 100).toFixed(2)}%.`
      );
      lines.push(
        `F. Rebuild reliability: plus10 sequences baseline/failed/corrected = ${scaleSummary.baseline.lowEquityRiskOnSequencesReachingPlus10Pct}/${failed.lowEquityRiskOnSequencesReachingPlus10Pct}/${corrected.lowEquityRiskOnSequencesReachingPlus10Pct}; reached 40% = ${scaleSummary.baseline.lowEquityRiskOnSequencesReaching40Pct}/${failed.lowEquityRiskOnSequencesReaching40Pct}/${corrected.lowEquityRiskOnSequencesReaching40Pct}.`
      );
      lines.push('');
    }
  }
  lines.push('## Recommendation');
  if (semanticFixAchieved && !economicRescueAchieved) {
    lines.push(
      `The corrected handoff fixes the audited semantic failure: corrected runs produced ${semanticNegativeSteps}/${semanticPositiveSteps} negative realized deltas on positive-request steps and ${semanticViolationSteps} controller-delta sell-order violations.`
    );
    lines.push(
      `It does not yet rescue the Two-Layer direction economically. Corrected runs still produced ${correctedNonPositiveSteps}/${semanticPositiveSteps} non-positive realized outcomes on positive-request steps, averaged only $${averagePlannedDeltaBuyUsd.toFixed(2)} planned delta buys and $${averageExecutedDeltaBuyUsd.toFixed(2)} executed delta buys, improved realized equity versus the failed variant in ${improvedVsFailedEquityRuns}/${allCorrectedRuns.length} runs, beat baseline realized equity in ${improvedVsBaselineEquityRuns}/${allCorrectedRuns.length} runs, reduced favorable-state cash versus the failed variant in ${improvedVsFailedCashRuns}/${allCorrectedRuns.length} runs, and improved rebuild reliability in ${correctedRebuildWins}/${allCorrectedRuns.length} runs.`
    );
    lines.push(
      'Recommendation: keep the Two-Layer direction alive, keep the old scaled-basket handoff abandoned, and revise the incremental-delta path again before promotion. The next revision should focus on controller advance behavior and delta executability, because the semantic fix alone did not rebuild equity reliably.'
    );
  } else if (economicRescueAchieved) {
    lines.push(
      'The corrected handoff fixes the semantic failure and materially improves the primary economic outcomes. Recommendation: continue the Two-Layer direction with the incremental-delta contract as the active handoff.'
    );
  } else {
    lines.push(
      'The corrected handoff did not establish a clean semantic improvement. Recommendation: do not continue this implementation without another forensic pass on the contract path.'
    );
  }
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
        const generatedConfigPath = path.join(
          OUTPUT_ROOT,
          'generated_configs',
          `${variant.key}.scale_${scale}x.json`
        );
        writeJson(generatedConfigPath, config);

        const result = await runHistoricalReplay({
          input: bundle,
          configPath: generatedConfigPath,
          outputDir,
          runPrefix: `replay-exposure-state-${window.key}-${variant.key}-scale${scale}x`,
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
        exposureStateFailed: results.exposure_state_failed,
        exposureStateIncrementalDelta: results.exposure_state_incremental_delta,
        benchmarks,
        delta: {
          averageRealizedEquityAllocation: round(
            results.exposure_state_incremental_delta.averageRealizedEquityAllocation -
              results.baseline.averageRealizedEquityAllocation
          ),
          averageRiskOnCoreCashPct: round(
            results.exposure_state_incremental_delta.averageRiskOnCoreCashPct - results.baseline.averageRiskOnCoreCashPct
          ),
          strategyReturnPct: round(
            results.exposure_state_incremental_delta.strategyReturnPct - results.baseline.strategyReturnPct
          ),
          maxDrawdownPct: round(
            results.exposure_state_incremental_delta.maxDrawdownPct - results.baseline.maxDrawdownPct
          ),
          lowEquityRiskOnSequencesReachingPlus10Pct:
            results.exposure_state_incremental_delta.lowEquityRiskOnSequencesReachingPlus10Pct -
            results.baseline.lowEquityRiskOnSequencesReachingPlus10Pct,
          lowEquityRiskOnSequencesReaching40Pct:
            results.exposure_state_incremental_delta.lowEquityRiskOnSequencesReaching40Pct -
            results.baseline.lowEquityRiskOnSequencesReaching40Pct,
          riskOnStepsWithCoreCashGte50Pct:
            results.exposure_state_incremental_delta.riskOnStepsWithCoreCashGte50Pct -
            results.baseline.riskOnStepsWithCoreCashGte50Pct,
          averageRequestedExposureDeltaUsd: round(
            results.exposure_state_incremental_delta.averageRequestedExposureDeltaUsd -
              results.baseline.averageRequestedExposureDeltaUsd
          ),
          averageRealizedExposureDeltaUsd: round(
            results.exposure_state_incremental_delta.averageRealizedExposureDeltaUsd -
              results.baseline.averageRealizedExposureDeltaUsd
          ),
          averageShortfallUsd: round(
            results.exposure_state_incremental_delta.averageShortfallUsd - results.baseline.averageShortfallUsd
          ),
          realizedToRequestedExposureRatio: round(
            results.exposure_state_incremental_delta.realizedToRequestedExposureRatio -
              results.baseline.realizedToRequestedExposureRatio
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
    experiment: 'exposure_state_incremental_delta_scale_aware',
    scales: SCALES,
    baselineConfig: path.relative(ROOT, VARIANTS[0].configPath),
    failedVariantConfig: path.relative(ROOT, VARIANTS[1].configPath),
    incrementalDeltaVariantConfig: path.relative(ROOT, VARIANTS[2].configPath),
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,variant,avg_realized_equity_pct,avg_core_cash_pct,avg_risk_on_core_cash_pct,return_pct,max_drawdown_pct,low_entry_sequences,plus10_sequences,reached_40_sequences,risk_on_core_cash_gte_50_steps,avg_risk_on_buy_budget_usd,active_exposure_state_steps,controller_entries,controller_advances,controller_holds,controller_pauses,controller_exits,avg_target_core_equity_pct,avg_requested_exposure_delta_usd,avg_realized_exposure_delta_usd,avg_shortfall_usd,realized_to_requested_ratio,approved_buy_notional_pct_planned,positive_requested_delta_steps,positive_requested_delta_non_positive_realized_steps,positive_requested_delta_negative_realized_steps,controller_delta_sell_order_violations,avg_planned_delta_buy_usd,avg_approved_delta_buy_usd,avg_executed_delta_buy_usd'
  ];
  for (const window of windowSummaries) {
    for (const scaleSummary of window.scales) {
      const rows: Array<[string, VariantRunSummary]> = [
        ['baseline', scaleSummary.baseline],
        ['exposure_state_failed', scaleSummary.exposureStateFailed],
        ['exposure_state_incremental_delta', scaleSummary.exposureStateIncrementalDelta]
      ];
      for (const [variant, summary] of rows) {
        csvLines.push(
          [
            window.windowKey,
            String(scaleSummary.scale),
            variant,
            round(summary.averageRealizedEquityAllocation),
            round(summary.averageCoreCashPct),
            round(summary.averageRiskOnCoreCashPct),
            round(summary.strategyReturnPct),
            round(summary.maxDrawdownPct),
            String(summary.lowEquityRiskOnSequenceCount),
            String(summary.lowEquityRiskOnSequencesReachingPlus10Pct),
            String(summary.lowEquityRiskOnSequencesReaching40Pct),
            String(summary.riskOnStepsWithCoreCashGte50Pct),
            round(summary.averageRiskOnBuyBudgetUsd),
            String(summary.activeExposureStateSteps),
            String(summary.controllerEntryCount),
            String(summary.controllerAdvanceCount),
            String(summary.controllerHoldCount),
            String(summary.controllerPauseCount),
            String(summary.controllerExitCount),
            round(summary.averageTargetCoreEquityPct),
            round(summary.averageRequestedExposureDeltaUsd),
            round(summary.averageRealizedExposureDeltaUsd),
            round(summary.averageShortfallUsd),
            round(summary.realizedToRequestedExposureRatio),
            round(summary.approvedBuyNotionalPctOfPlanned),
            String(summary.positiveRequestedDeltaSteps),
            String(summary.positiveRequestedDeltaNonPositiveRealizedSteps),
            String(summary.positiveRequestedDeltaNegativeRealizedSteps),
            String(summary.controllerDeltaSellOrderViolationSteps),
            round(summary.averagePlannedDeltaBuyUsd),
            round(summary.averageApprovedDeltaBuyUsd),
            round(summary.averageExecutedDeltaBuyUsd)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), buildMemo(windowSummaries));

  console.log(`Exposure-state summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('exposure-state experiment failed', error);
  process.exitCode = 1;
});
