import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'headroom_expanded';

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
  riskOnStepsWithCoreCashGte50Pct: number;
  averageRiskOnCoreBuyCapacityUsd: number;
  averageRiskOnBuyBudgetUsd: number;
  activeHeadroomExpansionSteps: number;
  averageHeadroomSupplementUsd: number;
  coreBuyCapacityIncreaseSteps: number;
  buyBudgetIncreaseSteps: number;
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: Array<{
    scale: number;
    baseline: VariantRunSummary;
    headroomExpanded: VariantRunSummary;
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
      riskOnStepsWithCoreCashGte50Pct: number;
      averageRiskOnCoreBuyCapacityUsd: number;
      averageRiskOnBuyBudgetUsd: number;
      activeHeadroomExpansionSteps: number;
      averageHeadroomSupplementUsd: number;
      coreBuyCapacityIncreaseSteps: number;
      buyBudgetIncreaseSteps: number;
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
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/headroom_capacity_scale_aware_experiment');
const SCALES = [2, 3];
const VARIANTS: VariantSpec[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    configPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'headroom_expanded',
    label: 'Risk-on headroom expansion',
    configPath: path.join(ROOT, 'src/config/default.risk_on_headroom_expansion.position_size_scaled_risk_gate.json')
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
    if (sequence.some((point) => point.equityAllocationPct >= entry + 0.10)) sequencesReachingPlus10Pct += 1;
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

  let plannedBuyNotional = 0;
  let approvedBuyNotional = 0;
  let riskOnSteps = 0;
  const riskOnCoreBuyCapacities: number[] = [];
  const riskOnBuyBudgets: number[] = [];
  const supplements: number[] = [];
  let activeHeadroomExpansionSteps = 0;

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
    riskOnCoreBuyCapacities.push(Number(deploy.coreBuyCapacityUsd || 0));
    riskOnBuyBudgets.push(Number(deploy.buyBudgetUSD || 0));
    const supplementUsd = Number(deploy?.coreCapacityFormation?.supplementUsd || 0);
    supplements.push(supplementUsd);
    if (deploy?.coreCapacityFormation?.active) activeHeadroomExpansionSteps += 1;
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
    riskOnStepsWithCoreCashGte50Pct: sequenceSummary.riskOnStepsWithCoreCashGte50Pct,
    averageRiskOnCoreBuyCapacityUsd: round(average(riskOnCoreBuyCapacities)),
    averageRiskOnBuyBudgetUsd: round(average(riskOnBuyBudgets)),
    activeHeadroomExpansionSteps,
    averageHeadroomSupplementUsd: round(average(supplements)),
    coreBuyCapacityIncreaseSteps: 0,
    buyBudgetIncreaseSteps: 0
  };
};

const buildMemo = (windows: WindowSummary[]) => {
  const lines: string[] = ['# Headroom Capacity Scale-Aware Memo', ''];

  for (const window of windows) {
    lines.push(`## ${window.windowLabel}`);
    for (const scaleSummary of window.scales) {
      const baseline6040 = scaleSummary.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');
      lines.push(`### ${scaleSummary.scale}x`);
      lines.push(
        `Risk_on core buy capacity moved $${scaleSummary.baseline.averageRiskOnCoreBuyCapacityUsd.toFixed(2)} -> $${scaleSummary.headroomExpanded.averageRiskOnCoreBuyCapacityUsd.toFixed(2)} and risk_on buy budget moved $${scaleSummary.baseline.averageRiskOnBuyBudgetUsd.toFixed(2)} -> $${scaleSummary.headroomExpanded.averageRiskOnBuyBudgetUsd.toFixed(2)}.`
      );
      lines.push(
        `Low-entry risk_on sequences reaching +10 equity points moved ${scaleSummary.baseline.lowEquityRiskOnSequencesReachingPlus10Pct}/${scaleSummary.baseline.lowEquityRiskOnSequenceCount} -> ${scaleSummary.headroomExpanded.lowEquityRiskOnSequencesReachingPlus10Pct}/${scaleSummary.headroomExpanded.lowEquityRiskOnSequenceCount}, and sequences reaching 40% equity moved ${scaleSummary.baseline.lowEquityRiskOnSequencesReaching40Pct} -> ${scaleSummary.headroomExpanded.lowEquityRiskOnSequencesReaching40Pct}.`
      );
      lines.push(
        `Average realized equity moved ${(scaleSummary.baseline.averageRealizedEquityAllocation * 100).toFixed(2)}% -> ${(scaleSummary.headroomExpanded.averageRealizedEquityAllocation * 100).toFixed(2)}%, while risk_on steps with core cash >= 50% moved ${scaleSummary.baseline.riskOnStepsWithCoreCashGte50Pct} -> ${scaleSummary.headroomExpanded.riskOnStepsWithCoreCashGte50Pct}.`
      );
      lines.push(
        `Return moved ${(scaleSummary.baseline.strategyReturnPct * 100).toFixed(2)}% -> ${(scaleSummary.headroomExpanded.strategyReturnPct * 100).toFixed(2)}% with max drawdown ${(scaleSummary.baseline.maxDrawdownPct * 100).toFixed(2)}% -> ${(scaleSummary.headroomExpanded.maxDrawdownPct * 100).toFixed(2)}%.`
      );
      if (baseline6040) {
        lines.push(
          `Variant versus 60/40 remains ${(scaleSummary.headroomExpanded.strategyReturnPct * 100).toFixed(2)}% vs ${(baseline6040.totalReturnPct * 100).toFixed(2)}%.`
        );
      }
      lines.push('');
    }
  }

  lines.push('## Recommendation');
  lines.push(
    'If direct headroom expansion finally increases core buy capacity and buy budgets on favorable underinvested steps, then core-lane capacity formation is the main remaining controllable bottleneck.'
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
          runPrefix: `replay-headroom-${window.key}-${variant.key}-scale${scale}x`,
          strategy: 'deterministic'
        });

        const summary = summarizeRun(result, bundle, exposureGroups);
        summary.scale = scale;
        summary.outputDir = outputDir;
        summary.configPath = path.relative(ROOT, generatedConfigPath);
        results[variant.key] = summary;
      }

      const baselineReplay = readJson<any>(path.join(results.baseline.outputDir, 'replay_result.json'));
      const variantReplay = readJson<any>(path.join(results.headroom_expanded.outputDir, 'replay_result.json'));
      let coreBuyCapacityIncreaseSteps = 0;
      let buyBudgetIncreaseSteps = 0;

      for (let i = 0; i < Math.min(baselineReplay.steps.length, variantReplay.steps.length); i += 1) {
        const baselineStep = baselineReplay.steps[i];
        const variantStep = variantReplay.steps[i];
        const baselineDeploy = readJson<any>(path.join(ROOT, 'runs', baselineStep.runId, 'capital_deployment.json'));
        const variantDeploy = readJson<any>(path.join(ROOT, 'runs', variantStep.runId, 'capital_deployment.json'));
        if (baselineDeploy?.basis?.equityRegimeLabel !== 'risk_on') continue;
        if (Number(variantDeploy.coreBuyCapacityUsd || 0) > Number(baselineDeploy.coreBuyCapacityUsd || 0) + 1e-6) {
          coreBuyCapacityIncreaseSteps += 1;
        }
        if (Number(variantDeploy.buyBudgetUSD || 0) > Number(baselineDeploy.buyBudgetUSD || 0) + 1e-6) {
          buyBudgetIncreaseSteps += 1;
        }
      }

      results.headroom_expanded.coreBuyCapacityIncreaseSteps = coreBuyCapacityIncreaseSteps;
      results.headroom_expanded.buyBudgetIncreaseSteps = buyBudgetIncreaseSteps;

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
        headroomExpanded: results.headroom_expanded,
        benchmarks,
        delta: {
          averageRealizedEquityAllocation: round(
            results.headroom_expanded.averageRealizedEquityAllocation - results.baseline.averageRealizedEquityAllocation
          ),
          averageCoreCashPct: round(results.headroom_expanded.averageCoreCashPct - results.baseline.averageCoreCashPct),
          strategyReturnPct: round(results.headroom_expanded.strategyReturnPct - results.baseline.strategyReturnPct),
          maxDrawdownPct: round(results.headroom_expanded.maxDrawdownPct - results.baseline.maxDrawdownPct),
          lowEquityRiskOnSequencesReachingPlus10Pct:
            results.headroom_expanded.lowEquityRiskOnSequencesReachingPlus10Pct -
            results.baseline.lowEquityRiskOnSequencesReachingPlus10Pct,
          lowEquityRiskOnSequencesReaching40Pct:
            results.headroom_expanded.lowEquityRiskOnSequencesReaching40Pct -
            results.baseline.lowEquityRiskOnSequencesReaching40Pct,
          riskOnStepsWithCoreCashGte50Pct:
            results.headroom_expanded.riskOnStepsWithCoreCashGte50Pct -
            results.baseline.riskOnStepsWithCoreCashGte50Pct,
          averageRiskOnCoreBuyCapacityUsd: round(
            results.headroom_expanded.averageRiskOnCoreBuyCapacityUsd - results.baseline.averageRiskOnCoreBuyCapacityUsd
          ),
          averageRiskOnBuyBudgetUsd: round(
            results.headroom_expanded.averageRiskOnBuyBudgetUsd - results.baseline.averageRiskOnBuyBudgetUsd
          ),
          activeHeadroomExpansionSteps:
            results.headroom_expanded.activeHeadroomExpansionSteps - results.baseline.activeHeadroomExpansionSteps,
          averageHeadroomSupplementUsd: round(
            results.headroom_expanded.averageHeadroomSupplementUsd - results.baseline.averageHeadroomSupplementUsd
          ),
          coreBuyCapacityIncreaseSteps: results.headroom_expanded.coreBuyCapacityIncreaseSteps,
          buyBudgetIncreaseSteps: results.headroom_expanded.buyBudgetIncreaseSteps
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
    experiment: 'headroom_capacity_scale_aware',
    scales: SCALES,
    baselineConfig: path.relative(ROOT, VARIANTS[0].configPath),
    variantConfig: path.relative(ROOT, VARIANTS[1].configPath),
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,variant,avg_realized_equity_pct,avg_core_cash_pct,return_pct,max_drawdown_pct,low_entry_sequences,plus10_sequences,reached_40_sequences,risk_on_core_cash_gte_50_steps,avg_risk_on_core_buy_capacity_usd,avg_risk_on_buy_budget_usd,active_headroom_steps,avg_headroom_supplement_usd,core_buy_capacity_increase_steps,buy_budget_increase_steps,approved_buy_notional_pct_planned'
  ];
  for (const window of windowSummaries) {
    for (const scaleSummary of window.scales) {
      const rows: Array<[string, VariantRunSummary]> = [
        ['baseline', scaleSummary.baseline],
        ['headroom_expanded', scaleSummary.headroomExpanded]
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
            String(summary.riskOnStepsWithCoreCashGte50Pct),
            round(summary.averageRiskOnCoreBuyCapacityUsd),
            round(summary.averageRiskOnBuyBudgetUsd),
            String(summary.activeHeadroomExpansionSteps),
            round(summary.averageHeadroomSupplementUsd),
            String(summary.coreBuyCapacityIncreaseSteps),
            String(summary.buyBudgetIncreaseSteps),
            round(summary.approvedBuyNotionalPctOfPlanned)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), buildMemo(windowSummaries));

  console.log(`Headroom capacity summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('headroom capacity scale-aware experiment failed', error);
  process.exitCode = 1;
});
