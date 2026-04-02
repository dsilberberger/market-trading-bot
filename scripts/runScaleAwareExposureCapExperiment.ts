import fs from 'fs';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import { BotConfig } from '../src/core/types';
import { ExposureGroups } from '../src/core/exposureGroups';

type VariantKey = 'baseline' | 'exposure_cap_eased';

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
  stepsWithRiskBlockedBuys: number;
  riskOnSteps: number;
  averageRiskOnExposureCap: number;
  riskOnCapBoundSteps: number;
  riskOnCashBoundSteps: number;
  riskOnBuyBudgetIncreaseSteps: number;
  averageRiskOnBuyBudgetUsd: number;
}

interface WindowSummary {
  windowKey: string;
  windowLabel: string;
  classification: string;
  scales: Array<{
    scale: number;
    baseline: VariantRunSummary;
    exposureCapEased: VariantRunSummary;
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
      averageRiskOnExposureCap: number;
      riskOnCapBoundSteps: number;
      riskOnCashBoundSteps: number;
      riskOnBuyBudgetIncreaseSteps: number;
      averageRiskOnBuyBudgetUsd: number;
    };
  }>;
}

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'research/broad_validation/runs/exposure_cap_scale_aware_experiment');
const SCALES = [2, 3];
const VARIANTS: VariantSpec[] = [
  {
    key: 'baseline',
    label: 'Promoted working baseline',
    configPath: path.join(ROOT, 'src/config/default.json')
  },
  {
    key: 'exposure_cap_eased',
    label: 'Conditioned coarse-percentile cap',
    configPath: path.join(ROOT, 'src/config/default.conditioned_coarse_cap.position_size_scaled_risk_gate.json')
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

  let plannedBuyNotional = 0;
  let approvedBuyNotional = 0;
  let stepsWithRiskBlockedBuys = 0;
  let riskOnSteps = 0;
  const riskOnExposureCaps: number[] = [];
  const riskOnBuyBudgets: number[] = [];
  let riskOnCapBoundSteps = 0;
  let riskOnCashBoundSteps = 0;

  for (const step of result.steps) {
    const runDir = path.join(ROOT, 'runs', step.runId);
    const deploy = readJson<any>(path.join(runDir, 'capital_deployment.json'));
    const budgetEnforcement = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    const riskReport = readJson<any>(path.join(runDir, 'risk_report.json'));
    const capitalBudgets = readJson<any>(path.join(runDir, 'capital_budgets.json'));
    const proposal = readJson<any>(path.join(runDir, 'proposal.json'));

    const plannedStepBuyNotional = Number(budgetEnforcement?.etf?.plannedBuyUsd || 0);
    const approvedStepBuyNotional = Array.isArray(riskReport?.approvedOrders)
      ? riskReport.approvedOrders
          .filter((order: any) => order.side === 'BUY')
          .reduce((sum: number, order: any) => sum + Number(order.notionalUSD || 0), 0)
      : 0;

    plannedBuyNotional += plannedStepBuyNotional;
    approvedBuyNotional += approvedStepBuyNotional;
    if (plannedStepBuyNotional > 0 && approvedStepBuyNotional === 0) stepsWithRiskBlockedBuys += 1;

    if (deploy?.basis?.equityRegimeLabel !== 'risk_on') continue;

    riskOnSteps += 1;
    const deployBudgetUsd = Number(deploy.deployBudgetUsd || 0);
    const buyBudgetUSD = Number(deploy.buyBudgetUSD || 0);
    const capBudgetUsd = Number(deploy.capBudgetUsd || 0);
    const coreCashUsd = Number(deploy.coreCashUsd || 0);
    const coreHeadroomUsd = Number(capitalBudgets?.capitalLanes?.coreHeadroomUsd || 0);
    const estimatedSellProceedsUsd = (proposal?.intent?.orders || [])
      .filter((order: any) => order.side === 'SELL')
      .reduce((sum: number, order: any) => sum + Math.abs(Number(order.notionalUSD || 0)), 0);
    const coreBuyCapacityUsd = Math.max(
      0,
      Math.min(coreCashUsd + estimatedSellProceedsUsd, coreHeadroomUsd + estimatedSellProceedsUsd)
    );

    riskOnExposureCaps.push(Number(deploy.exposureCap || 0));
    riskOnBuyBudgets.push(buyBudgetUSD);

    if (capBudgetUsd <= buyBudgetUSD + 1e-6) riskOnCapBoundSteps += 1;
    else if (coreBuyCapacityUsd <= buyBudgetUSD + 1e-6) riskOnCashBoundSteps += 1;
    else if (deployBudgetUsd <= buyBudgetUSD + 1e-6) {
      // intentionally no-op; deploy-bound steps are not the focus of this experiment
    }
  }

  return {
    scale: 1,
    outputDir: result.outputDir,
    configPath: '',
    strategyReturnPct: strategy.totalReturnPct,
    maxDrawdownPct: strategy.maxDrawdownPct,
    endingValue: strategy.endingValue,
    annualizedVolatilityPct: strategy.annualizedVolatilityPct ?? null,
    averageRealizedEquityAllocation: round(computeAverageRealizedEquityAllocation(holdingsHistory, closeMap, equitySet)),
    averageCoreCashPct: round(validation.strategy?.coreLaneMetrics?.averageCoreCashPct ?? 0),
    approvedBuyNotionalPctOfPlanned: round(approvedBuyNotional / Math.max(plannedBuyNotional, 1e-9), 6),
    stepsWithRiskBlockedBuys,
    riskOnSteps,
    averageRiskOnExposureCap: round(average(riskOnExposureCaps)),
    riskOnCapBoundSteps,
    riskOnCashBoundSteps,
    riskOnBuyBudgetIncreaseSteps: 0,
    averageRiskOnBuyBudgetUsd: round(average(riskOnBuyBudgets))
  };
};

const buildMemo = (windows: WindowSummary[]) => {
  const lines: string[] = ['# Exposure Cap Scale-Aware Memo', ''];

  for (const window of windows) {
    lines.push(`## ${window.windowLabel}`);
    for (const scaleSummary of window.scales) {
      const baseline6040 = scaleSummary.benchmarks.find((entry) => entry.portfolio === '60/40 (VTI/BND)');
      lines.push(`### ${scaleSummary.scale}x`);
      lines.push(
        `Risk-on average cap moved ${(scaleSummary.baseline.averageRiskOnExposureCap * 100).toFixed(2)}% -> ${(scaleSummary.exposureCapEased.averageRiskOnExposureCap * 100).toFixed(2)}%, and average realized equity moved ${(scaleSummary.baseline.averageRealizedEquityAllocation * 100).toFixed(2)}% -> ${(scaleSummary.exposureCapEased.averageRealizedEquityAllocation * 100).toFixed(2)}%.`
      );
      lines.push(
        `Average risk-on buy budget moved $${scaleSummary.baseline.averageRiskOnBuyBudgetUsd.toFixed(2)} -> $${scaleSummary.exposureCapEased.averageRiskOnBuyBudgetUsd.toFixed(2)}; cap-bound steps moved ${scaleSummary.baseline.riskOnCapBoundSteps} -> ${scaleSummary.exposureCapEased.riskOnCapBoundSteps}.`
      );
      lines.push(
        `Return moved ${(scaleSummary.baseline.strategyReturnPct * 100).toFixed(2)}% -> ${(scaleSummary.exposureCapEased.strategyReturnPct * 100).toFixed(2)}% with max drawdown ${(scaleSummary.baseline.maxDrawdownPct * 100).toFixed(2)}% -> ${(scaleSummary.exposureCapEased.maxDrawdownPct * 100).toFixed(2)}%.`
      );
      if (baseline6040) {
        lines.push(
          `Cap-eased versus 60/40 remains ${(scaleSummary.exposureCapEased.strategyReturnPct * 100).toFixed(2)}% vs ${(baseline6040.totalReturnPct * 100).toFixed(2)}%.`
        );
      }
      lines.push('');
    }
  }

  lines.push('## Recommendation');
  lines.push(
    'If a modest favorable-state cap relaxation raises buy budgets and realized equity without disproportionate drawdown, exposureCap remains the cleanest controllable limiter of the current conservatism.'
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
          runPrefix: `replay-exposure-cap-${window.key}-${variant.key}-scale${scale}x`,
          strategy: 'deterministic'
        });

        const summary = summarizeRun(result, bundle, exposureGroups);
        summary.scale = scale;
        summary.outputDir = outputDir;
        summary.configPath = path.relative(ROOT, generatedConfigPath);
        results[variant.key] = summary;
      }

      const baselineReplay = readJson<any>(path.join(results.baseline.outputDir, 'replay_result.json'));
      const variantReplay = readJson<any>(path.join(results.exposure_cap_eased.outputDir, 'replay_result.json'));

      let riskOnBuyBudgetIncreaseSteps = 0;
      for (let i = 0; i < Math.min(baselineReplay.steps.length, variantReplay.steps.length); i += 1) {
        const baselineStep = baselineReplay.steps[i];
        const variantStep = variantReplay.steps[i];
        const baselineDeploy = readJson<any>(path.join(ROOT, 'runs', baselineStep.runId, 'capital_deployment.json'));
        const variantDeploy = readJson<any>(path.join(ROOT, 'runs', variantStep.runId, 'capital_deployment.json'));
        if (baselineDeploy?.basis?.equityRegimeLabel !== 'risk_on') continue;
        if (Number(variantDeploy.buyBudgetUSD || 0) > Number(baselineDeploy.buyBudgetUSD || 0) + 1e-6) {
          riskOnBuyBudgetIncreaseSteps += 1;
        }
      }

      results.exposure_cap_eased.riskOnBuyBudgetIncreaseSteps = riskOnBuyBudgetIncreaseSteps;

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
        exposureCapEased: results.exposure_cap_eased,
        benchmarks,
        delta: {
          averageRealizedEquityAllocation: round(
            results.exposure_cap_eased.averageRealizedEquityAllocation - results.baseline.averageRealizedEquityAllocation
          ),
          averageCoreCashPct: round(results.exposure_cap_eased.averageCoreCashPct - results.baseline.averageCoreCashPct),
          strategyReturnPct: round(results.exposure_cap_eased.strategyReturnPct - results.baseline.strategyReturnPct),
          maxDrawdownPct: round(results.exposure_cap_eased.maxDrawdownPct - results.baseline.maxDrawdownPct),
          averageRiskOnExposureCap: round(
            results.exposure_cap_eased.averageRiskOnExposureCap - results.baseline.averageRiskOnExposureCap
          ),
          riskOnCapBoundSteps: results.exposure_cap_eased.riskOnCapBoundSteps - results.baseline.riskOnCapBoundSteps,
          riskOnCashBoundSteps: results.exposure_cap_eased.riskOnCashBoundSteps - results.baseline.riskOnCashBoundSteps,
          riskOnBuyBudgetIncreaseSteps: results.exposure_cap_eased.riskOnBuyBudgetIncreaseSteps,
          averageRiskOnBuyBudgetUsd: round(
            results.exposure_cap_eased.averageRiskOnBuyBudgetUsd - results.baseline.averageRiskOnBuyBudgetUsd
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
    experiment: 'exposure_cap_scale_aware',
    scales: SCALES,
    baselineConfig: path.relative(ROOT, VARIANTS[0].configPath),
    variantConfig: path.relative(ROOT, VARIANTS[1].configPath),
    windows: windowSummaries
  });

  const csvLines = [
    'window,scale,variant,avg_realized_equity_pct,avg_core_cash_pct,return_pct,max_drawdown_pct,avg_risk_on_exposure_cap,risk_on_cap_bound_steps,risk_on_cash_bound_steps,risk_on_buy_budget_increase_steps,avg_risk_on_buy_budget_usd,approved_buy_notional_pct_planned'
  ];
  for (const window of windowSummaries) {
    for (const scaleSummary of window.scales) {
      const rows: Array<[string, VariantRunSummary]> = [
        ['baseline', scaleSummary.baseline],
        ['exposure_cap_eased', scaleSummary.exposureCapEased]
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
            round(summary.averageRiskOnExposureCap),
            String(summary.riskOnCapBoundSteps),
            String(summary.riskOnCashBoundSteps),
            String(summary.riskOnBuyBudgetIncreaseSteps),
            round(summary.averageRiskOnBuyBudgetUsd),
            round(summary.approvedBuyNotionalPctOfPlanned)
          ].join(',')
        );
      }
    }
  }
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'comparison_summary.csv'), `${csvLines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'decision_memo.md'), buildMemo(windowSummaries));

  console.log(`Exposure cap summary: ${summaryPath}`);
};

run().catch((error) => {
  console.error('exposure cap scale-aware experiment failed', error);
  process.exitCode = 1;
});
