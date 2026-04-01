import fs from 'fs';
import path from 'path';
import type { TradeOrder, LedgerEvent } from '../core/types';
import { BenchmarkResult, BenchmarkSummaryStats } from './benchmarkPortfolios';
import type { HistoricalReplayInput, ReplayStepSummary } from './runHistoricalReplay';

interface StrategyOrderLogEntry {
  date: string;
  runId: string;
  order: TradeOrder;
}

interface SleeveEventLogEntry {
  date: string;
  runId: string;
  code: string;
  message: string;
  observed?: any;
}

export interface ValidationPortfolioSummaryRow {
  runPrefix: string;
  windowStart: string;
  windowEnd: string;
  portfolio: string;
  type: 'strategy' | 'benchmark';
  totalReturnPct: number;
  annualizedReturnPct?: number;
  maxDrawdownPct: number;
  annualizedVolatilityPct?: number;
  endingValue: number;
  startingValue: number;
  tradeCount: number;
  grossTradedNotionalUsd: number;
  turnoverPct?: number;
  peakDateBeforeMaxDrawdown?: string;
  troughDate?: string;
  recoveryDate?: string;
  recoveryBars?: number;
}

export interface StrategyDiagnostics {
  regimeDistribution: {
    counts: {
      risk_on: number;
      neutral: number;
      risk_off: number;
      unknown: number;
    };
    percentages: {
      risk_on: number;
      neutral: number;
      risk_off: number;
      unknown: number;
    };
  };
  sleeveMetrics: {
    dislocationTriggerCount: number;
    sleeveBuyExecutionCount: number;
    totalReserveCapitalDeployedUsd: number;
    peakReserveDeploymentUsd: number;
    peakReserveDeploymentDate?: string;
  };
  coreLaneSummary: {
    averageCoreCashUsd: number;
    averageCoreCashPct: number;
    averageDislocationCoreUsageUsd: number;
    peakDislocationCoreUsageUsd: number;
    peakDislocationCoreUsageDate?: string;
  };
  sleeveTriggerTimeline: SleeveEventLogEntry[];
  reserveUsageSummary: {
    accountingScope: 'executed_replay_only';
    averageReserveUsageUsd: number;
    peakReserveUsageUsd: number;
    peakReserveUsageDate?: string;
    averageReservePct: number;
    minReservePct: number;
    maxReservePct: number;
  };
  plannedOptionSleeveStateSummary: {
    accountingScope: 'planned_non_executed_option_state';
    averagePlannedOptionReserveStateUsd: number;
    peakPlannedOptionReserveStateUsd: number;
    peakPlannedOptionReserveStateDate?: string;
    activeStepCount: number;
    averageInsurancePremiumStateUsd: number;
    averageGrowthPremiumStateUsd: number;
    peakInsurancePremiumStateUsd: number;
    peakGrowthPremiumStateUsd: number;
  };
  tradeSummary: {
    tradeCount: number;
    grossTradedNotionalUsd: number;
    turnoverPct?: number;
  };
  blockedOrRejectedActions: Array<{
    date: string;
    runId: string;
    type: string;
    reasons: string[];
  }>;
  blockedOrRejectedSummary: {
    count: number;
    byType: Record<string, number>;
    byReason: Record<string, number>;
  };
}

export interface ValidationSummaryArtifact {
  metadata: {
    runPrefix: string;
    dateRange: {
      start: string;
      end: string;
    };
    barFrequency: '1d' | '1w';
    warmup: {
      preRollBarsRequested: number;
      warmupStepCount: number;
      firstWarmupDate?: string;
      lastWarmupDate?: string;
      firstCompletedDate?: string;
    };
    benchmarkNames: string[];
  };
  portfolios: ValidationPortfolioSummaryRow[];
  strategy: {
    regimeOccupancy: StrategyDiagnostics['regimeDistribution'];
    sleeveMetrics: StrategyDiagnostics['sleeveMetrics'];
    coreLaneMetrics: StrategyDiagnostics['coreLaneSummary'];
    reserveMetrics: StrategyDiagnostics['reserveUsageSummary'];
    plannedOptionSleeveState: StrategyDiagnostics['plannedOptionSleeveStateSummary'];
  };
}

export interface ValidationArtifacts {
  validationSummary: ValidationSummaryArtifact;
  portfolioSummaryRows: ValidationPortfolioSummaryRow[];
  strategyDiagnostics: StrategyDiagnostics;
}

const writeCsv = (filePath: string, header: string[], rows: string[][]) => {
  const escape = (value: string | undefined) => {
    const normalized = value ?? '';
    if (normalized.includes(',') || normalized.includes('"') || normalized.includes('\n')) {
      return `"${normalized.replace(/"/g, '""')}"`;
    }
    return normalized;
  };
  const lines = [header.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
};

const readReplayLedger = (outputDir: string): LedgerEvent[] => {
  const ledgerFile = path.join(outputDir, 'ledger', 'events.jsonl');
  if (!fs.existsSync(ledgerFile)) return [];
  const lines = fs
    .readFileSync(ledgerFile, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is LedgerEvent => Boolean(event));
};

const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const computeTurnoverPct = (grossTradedNotionalUsd: number, equities: number[]) => {
  const avgEquity = average(equities);
  return avgEquity > 0 ? grossTradedNotionalUsd / avgEquity : undefined;
};

const toPercentages = (counts: Record<'risk_on' | 'neutral' | 'risk_off' | 'unknown', number>) => {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total <= 0) {
    return {
      risk_on: 0,
      neutral: 0,
      risk_off: 0,
      unknown: 0
    };
  }
  return {
    risk_on: counts.risk_on / total,
    neutral: counts.neutral / total,
    risk_off: counts.risk_off / total,
    unknown: counts.unknown / total
  };
};

const buildPortfolioRow = ({
  runPrefix,
  windowStart,
  windowEnd,
  portfolio,
  type,
  summaryStats,
  tradeCount,
  grossTradedNotionalUsd,
  equityCurve
}: {
  runPrefix: string;
  windowStart: string;
  windowEnd: string;
  portfolio: string;
  type: 'strategy' | 'benchmark';
  summaryStats: BenchmarkSummaryStats;
  tradeCount: number;
  grossTradedNotionalUsd: number;
  equityCurve: Array<{ equity: number }>;
}): ValidationPortfolioSummaryRow => {
  const row: ValidationPortfolioSummaryRow = {
    runPrefix,
    windowStart,
    windowEnd,
    portfolio,
    type,
    totalReturnPct: summaryStats.totalReturnPct,
    maxDrawdownPct: summaryStats.maxDrawdownPct,
    endingValue: summaryStats.endEquity,
    startingValue: summaryStats.startEquity,
    tradeCount,
    grossTradedNotionalUsd,
    annualizedReturnPct: summaryStats.annualizedReturnPct,
    annualizedVolatilityPct: summaryStats.annualizedVolatilityPct ?? undefined,
    turnoverPct: computeTurnoverPct(grossTradedNotionalUsd, equityCurve.map((point) => point.equity)),
    peakDateBeforeMaxDrawdown: summaryStats.peakDateBeforeMaxDrawdown,
    troughDate: summaryStats.troughDate ?? undefined,
    recoveryDate: summaryStats.recoveryDate ?? undefined,
    recoveryBars: summaryStats.recoveryBars ?? undefined
  };
  return row;
};

const normalizeReasons = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeReasons(entry));
  }
  if (value === undefined || value === null) return [];
  return [String(value)];
};

const extractBlockedActions = (
  outputDir: string,
  stepByRunId: Map<string, ReplayStepSummary>
): StrategyDiagnostics['blockedOrRejectedActions'] => {
  const byRun = new Map<string, LedgerEvent[]>();
  for (const event of readReplayLedger(outputDir)) {
    const events = byRun.get(event.runId) || [];
    events.push(event);
    byRun.set(event.runId, events);
  }

  return Array.from(byRun.entries())
    .flatMap(([runId, events]) =>
      events
        .filter((event) => ['RUN_FAILED', 'RUN_REJECTED', 'RUN_SKIPPED'].includes(event.type))
        .map((event) => {
          const step = stepByRunId.get(runId);
          return {
            date: step?.date || runId.slice(-10),
            runId,
            type: event.type,
            reasons: [
              ...normalizeReasons(event.details?.reason),
              ...normalizeReasons(event.details?.blocked)
            ].filter(Boolean)
          };
        })
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.runId.localeCompare(b.runId));
};

const summarizeBlockedActions = (actions: StrategyDiagnostics['blockedOrRejectedActions']) => {
  const byType: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const action of actions) {
    byType[action.type] = (byType[action.type] || 0) + 1;
    for (const reason of action.reasons) {
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
  }
  return { count: actions.length, byType, byReason };
};

export const buildValidationArtifacts = ({
  input,
  outputDir,
  runPrefix,
  steps,
  strategyEquityCurve,
  strategyPerformance,
  strategyOrderLog,
  sleeveEventLog,
  benchmarkResults
}: {
  input: HistoricalReplayInput;
  outputDir: string;
  runPrefix: string;
  steps: ReplayStepSummary[];
  strategyEquityCurve: Array<{ date: string; equity: number; cash: number }>;
  strategyPerformance: BenchmarkSummaryStats;
  strategyOrderLog: StrategyOrderLogEntry[];
  sleeveEventLog: SleeveEventLogEntry[];
  benchmarkResults: BenchmarkResult[];
}): ValidationArtifacts => {
  const regimeCounts = steps.reduce(
    (counts, step) => {
      if (step.regime === 'risk_on' || step.regime === 'neutral' || step.regime === 'risk_off') {
        counts[step.regime] += 1;
      } else {
        counts.unknown += 1;
      }
      return counts;
    },
    { risk_on: 0, neutral: 0, risk_off: 0, unknown: 0 }
  );

  const reserveUsageSeries = steps.map((step) => ({
    date: step.date,
    reserveUsageUsd: step.executedOptionReserveUsageUsd,
    reservePct: step.holdingsAfterExecution.equity > 0 ? step.executedOptionReserveUsageUsd / step.holdingsAfterExecution.equity : 0
  }));
  const peakReservePoint = reserveUsageSeries.reduce(
    (peak, point) => (point.reserveUsageUsd > peak.reserveUsageUsd ? point : peak),
    { date: '', reserveUsageUsd: 0, reservePct: 0 }
  );
  const coreLaneSeries = steps.map((step) => ({
    date: step.date,
    coreCashUsd: step.capitalLanes.coreCashUsd,
    coreCashPct: step.holdingsAfterExecution.equity > 0 ? step.capitalLanes.coreCashUsd / step.holdingsAfterExecution.equity : 0,
    dislocationCoreUsageUsd: step.capitalLanes.executedDislocationCoreUsageUsd
  }));
  const peakDislocationCorePoint = coreLaneSeries.reduce(
    (peak, point) =>
      point.dislocationCoreUsageUsd > peak.dislocationCoreUsageUsd ? point : peak,
    { date: '', coreCashUsd: 0, coreCashPct: 0, dislocationCoreUsageUsd: 0 }
  );
  const plannedOptionStateSeries = steps.map((step) => ({
    date: step.date,
    plannedOptionReserveStateUsd: step.plannedOptionReserveStateUsd,
    insurancePremiumStateUsd: step.plannedOptionReserveStateBySleeve.insurancePremiumStateUsd,
    growthPremiumStateUsd: step.plannedOptionReserveStateBySleeve.growthPremiumStateUsd
  }));
  const peakPlannedOptionStatePoint = plannedOptionStateSeries.reduce(
    (peak, point) =>
      point.plannedOptionReserveStateUsd > peak.plannedOptionReserveStateUsd ? point : peak,
    {
      date: '',
      plannedOptionReserveStateUsd: 0,
      insurancePremiumStateUsd: 0,
      growthPremiumStateUsd: 0
    }
  );

  const dislocationTriggerCount = sleeveEventLog.filter((event) =>
    ['DISLOCATION_TRIGGERED', 'DISLOCATION_SLEEVE_TRIGGERED'].includes(event.code)
  ).length;
  const sleeveBuyOrders = strategyOrderLog.filter(
    (entry) => entry.order.side === 'BUY' && entry.order.sleeve === 'dislocation'
  );
  const strategyGrossTradedNotionalUsd = strategyOrderLog.reduce((sum, entry) => sum + Math.abs(entry.order.notionalUSD || 0), 0);
  const strategyPortfolioRow = buildPortfolioRow({
    runPrefix,
    windowStart: input.dateRange.start,
    windowEnd: input.dateRange.end,
    portfolio: 'Current Strategy',
    type: 'strategy',
    summaryStats: strategyPerformance,
    tradeCount: strategyOrderLog.length,
    grossTradedNotionalUsd: strategyGrossTradedNotionalUsd,
    equityCurve: strategyEquityCurve
  });

  const benchmarkRows = benchmarkResults.map((benchmark) =>
    buildPortfolioRow({
      runPrefix,
      windowStart: input.dateRange.start,
      windowEnd: input.dateRange.end,
      portfolio: benchmark.label,
      type: 'benchmark',
      summaryStats: benchmark.summaryStats,
      tradeCount: benchmark.orderLog.length,
      grossTradedNotionalUsd: benchmark.orderLog.reduce((sum, order) => sum + Math.abs(order.notionalUSD || 0), 0),
      equityCurve: benchmark.equityCurve
    })
  );

  const stepByRunId = new Map(steps.map((step) => [step.runId, step] as const));
  const blockedOrRejectedActions = extractBlockedActions(outputDir, stepByRunId);
  const strategyDiagnostics: StrategyDiagnostics = {
    regimeDistribution: {
      counts: regimeCounts,
      percentages: toPercentages(regimeCounts)
    },
    sleeveMetrics: {
      dislocationTriggerCount,
      sleeveBuyExecutionCount: sleeveBuyOrders.length,
      totalReserveCapitalDeployedUsd: sleeveBuyOrders.reduce((sum, entry) => sum + Math.abs(entry.order.notionalUSD || 0), 0),
      peakReserveDeploymentUsd: peakReservePoint.reserveUsageUsd,
      peakReserveDeploymentDate: peakReservePoint.date || undefined
    },
    coreLaneSummary: {
      averageCoreCashUsd: average(coreLaneSeries.map((point) => point.coreCashUsd)),
      averageCoreCashPct: average(coreLaneSeries.map((point) => point.coreCashPct)),
      averageDislocationCoreUsageUsd: average(coreLaneSeries.map((point) => point.dislocationCoreUsageUsd)),
      peakDislocationCoreUsageUsd: peakDislocationCorePoint.dislocationCoreUsageUsd,
      peakDislocationCoreUsageDate: peakDislocationCorePoint.date || undefined
    },
    sleeveTriggerTimeline: sleeveEventLog,
    reserveUsageSummary: {
      accountingScope: 'executed_replay_only',
      averageReserveUsageUsd: average(reserveUsageSeries.map((point) => point.reserveUsageUsd)),
      peakReserveUsageUsd: peakReservePoint.reserveUsageUsd,
      peakReserveUsageDate: peakReservePoint.date || undefined,
      averageReservePct: average(reserveUsageSeries.map((point) => point.reservePct)),
      minReservePct: reserveUsageSeries.length ? Math.min(...reserveUsageSeries.map((point) => point.reservePct)) : 0,
      maxReservePct: reserveUsageSeries.length ? Math.max(...reserveUsageSeries.map((point) => point.reservePct)) : 0
    },
    plannedOptionSleeveStateSummary: {
      accountingScope: 'planned_non_executed_option_state',
      averagePlannedOptionReserveStateUsd: average(
        plannedOptionStateSeries.map((point) => point.plannedOptionReserveStateUsd)
      ),
      peakPlannedOptionReserveStateUsd: peakPlannedOptionStatePoint.plannedOptionReserveStateUsd,
      peakPlannedOptionReserveStateDate: peakPlannedOptionStatePoint.date || undefined,
      activeStepCount: plannedOptionStateSeries.filter((point) => point.plannedOptionReserveStateUsd > 0).length,
      averageInsurancePremiumStateUsd: average(plannedOptionStateSeries.map((point) => point.insurancePremiumStateUsd)),
      averageGrowthPremiumStateUsd: average(plannedOptionStateSeries.map((point) => point.growthPremiumStateUsd)),
      peakInsurancePremiumStateUsd: plannedOptionStateSeries.length
        ? Math.max(...plannedOptionStateSeries.map((point) => point.insurancePremiumStateUsd))
        : 0,
      peakGrowthPremiumStateUsd: plannedOptionStateSeries.length
        ? Math.max(...plannedOptionStateSeries.map((point) => point.growthPremiumStateUsd))
        : 0
    },
    tradeSummary: {
      tradeCount: strategyOrderLog.length,
      grossTradedNotionalUsd: strategyGrossTradedNotionalUsd,
      turnoverPct: strategyPortfolioRow.turnoverPct
    },
    blockedOrRejectedActions,
    blockedOrRejectedSummary: summarizeBlockedActions(blockedOrRejectedActions)
  };

  const warmupSteps = steps.filter((step) => step.runStatus === 'warmup');
  const completedSteps = steps.filter((step) => step.runStatus === 'completed');
  const validationSummary: ValidationSummaryArtifact = {
    metadata: {
      runPrefix,
      dateRange: { ...input.dateRange },
      barFrequency: input.barFrequency,
      warmup: {
        preRollBarsRequested: Math.max(0, input.preRollBars ?? 0),
        warmupStepCount: warmupSteps.length,
        firstWarmupDate: warmupSteps[0]?.date,
        lastWarmupDate: warmupSteps.at(-1)?.date,
        firstCompletedDate: completedSteps[0]?.date
      },
      benchmarkNames: benchmarkResults.map((benchmark) => benchmark.label)
    },
    portfolios: [strategyPortfolioRow, ...benchmarkRows],
    strategy: {
      regimeOccupancy: strategyDiagnostics.regimeDistribution,
      sleeveMetrics: strategyDiagnostics.sleeveMetrics,
      coreLaneMetrics: strategyDiagnostics.coreLaneSummary,
      reserveMetrics: strategyDiagnostics.reserveUsageSummary,
      plannedOptionSleeveState: strategyDiagnostics.plannedOptionSleeveStateSummary
    }
  };

  return {
    validationSummary,
    portfolioSummaryRows: validationSummary.portfolios,
    strategyDiagnostics
  };
};

export const writeValidationArtifacts = ({
  outputDir,
  validationSummary,
  portfolioSummaryRows,
  strategyDiagnostics
}: ValidationArtifacts & { outputDir: string }) => {
  fs.writeFileSync(path.join(outputDir, 'validation_summary.json'), JSON.stringify(validationSummary, null, 2));
  fs.writeFileSync(path.join(outputDir, 'strategy_diagnostics.json'), JSON.stringify(strategyDiagnostics, null, 2));
  writeCsv(
    path.join(outputDir, 'validation_portfolio_summary.csv'),
    [
      'run_prefix',
      'window_start',
      'window_end',
      'portfolio',
      'type',
      'total_return_pct',
      'cagr_pct',
      'max_drawdown_pct',
      'annualized_volatility_pct',
      'ending_value',
      'starting_value',
      'trade_count',
      'gross_traded_notional_usd',
      'turnover_pct',
      'peak_date_before_max_drawdown',
      'trough_date',
      'recovery_date',
      'recovery_bars'
    ],
    portfolioSummaryRows.map((row) => [
      row.runPrefix,
      row.windowStart,
      row.windowEnd,
      row.portfolio,
      row.type,
      row.totalReturnPct.toFixed(8),
      row.annualizedReturnPct === undefined ? '' : row.annualizedReturnPct.toFixed(8),
      row.maxDrawdownPct.toFixed(8),
      row.annualizedVolatilityPct === undefined ? '' : row.annualizedVolatilityPct.toFixed(8),
      row.endingValue.toFixed(6),
      row.startingValue.toFixed(6),
      String(row.tradeCount),
      row.grossTradedNotionalUsd.toFixed(6),
      row.turnoverPct === undefined ? '' : row.turnoverPct.toFixed(8),
      row.peakDateBeforeMaxDrawdown || '',
      row.troughDate || '',
      row.recoveryDate || '',
      row.recoveryBars === undefined ? '' : String(row.recoveryBars)
    ])
  );
};
