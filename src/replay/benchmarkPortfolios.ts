import fs from 'fs';
import path from 'path';
import { HistoricalMarketDataProvider } from './historicalMarketData';

export interface BenchmarkCurvePoint {
  date: string;
  equity: number;
  cash: number;
}

export interface BenchmarkHoldingPoint {
  date: string;
  holdings: Record<string, number>;
  cash: number;
  equity: number;
}

export interface BenchmarkOrderLogEntry {
  date: string;
  requestedSymbol: string;
  resolvedSymbol: string;
  side: 'BUY' | 'SELL';
  notionalUSD: number;
  quantity: number;
  reason: 'initial_allocation' | 'quarterly_rebalance';
}

export interface BenchmarkSummaryStats {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  annualizedReturnPct?: number;
  maxDrawdownPct: number;
  annualizedVolatilityPct: number | null;
  peakDateBeforeMaxDrawdown?: string;
  troughDate: string | null;
  recoveryDate: string | null;
  recoveryBars: number | null;
  stepCount: number;
}

export interface BenchmarkResult {
  id: string;
  label: string;
  rebalancePolicy: 'quarterly';
  assumptions: string[];
  resolvedSymbols: Array<{
    requestedSymbol: string;
    resolvedSymbol: string;
    proxyUsed: boolean;
  }>;
  equityCurve: BenchmarkCurvePoint[];
  holdingsHistory: BenchmarkHoldingPoint[];
  orderLog: BenchmarkOrderLogEntry[];
  summaryStats: BenchmarkSummaryStats;
  outputFiles: {
    equityCurveCsv: string;
    holdingsHistoryJson: string;
    orderLogJson: string;
  };
}

interface BenchmarkDefinition {
  id: string;
  label: string;
  rebalancePolicy: 'quarterly';
  targets: Array<{
    symbol: string;
    weight: number;
    fallbackSymbols?: string[];
  }>;
  assumptions: string[];
}

const BENCHMARK_DEFINITIONS: BenchmarkDefinition[] = [
  {
    id: 'benchmark_60_40_vti_bnd',
    label: '60/40 (VTI/BND)',
    rebalancePolicy: 'quarterly',
    targets: [
      { symbol: 'VTI', weight: 0.6 },
      { symbol: 'BND', weight: 0.4, fallbackSymbols: ['IEF'] }
    ],
    assumptions: ['Quarterly rebalance on the first available replay date in each calendar quarter.']
  },
  {
    id: 'benchmark_80_20_vti_bnd',
    label: '80/20 (VTI/BND)',
    rebalancePolicy: 'quarterly',
    targets: [
      { symbol: 'VTI', weight: 0.8 },
      { symbol: 'BND', weight: 0.2, fallbackSymbols: ['IEF'] }
    ],
    assumptions: ['Quarterly rebalance on the first available replay date in each calendar quarter.']
  },
  {
    id: 'benchmark_100_equity_vti_vxus',
    label: '100% Equity (VTI/VXUS)',
    rebalancePolicy: 'quarterly',
    targets: [
      { symbol: 'VTI', weight: 0.6 },
      { symbol: 'VXUS', weight: 0.4 }
    ],
    assumptions: [
      'Quarterly rebalance on the first available replay date in each calendar quarter.',
      'Assumes a 60/40 split between VTI and VXUS.'
    ]
  }
];

const annualizationFactor = (barFrequency: '1d' | '1w') => (barFrequency === '1d' ? Math.sqrt(252) : Math.sqrt(52));

const annualizedReturn = (startEquity: number, endEquity: number, startDate: string, endDate: string) => {
  if (startEquity <= 0 || endEquity <= 0) return null;
  const elapsedMs = new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime();
  if (elapsedMs <= 0) return null;
  const elapsedYears = elapsedMs / (365.25 * 24 * 60 * 60 * 1000);
  if (elapsedYears <= 0) return null;
  return Math.pow(endEquity / startEquity, 1 / elapsedYears) - 1;
};

const quarterKey = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  const year = parsed.getUTCFullYear();
  const quarter = Math.floor(parsed.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
};

const sampleStdDev = (values: number[]) => {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
};

const computeSummaryStats = (
  equityCurve: BenchmarkCurvePoint[],
  barFrequency: '1d' | '1w'
): BenchmarkSummaryStats => {
  if (!equityCurve.length) {
    return {
      startEquity: 0,
      endEquity: 0,
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      annualizedVolatilityPct: null,
      troughDate: null,
      recoveryDate: null,
      recoveryBars: null,
      stepCount: 0
    };
  }

  let peakEquity = equityCurve[0].equity;
  let peakIndex = 0;
  let maxDrawdownPct = 0;
  let troughIndex = 0;
  let troughPeakEquity = peakEquity;
  let peakAtMaxDrawdownIndex = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const point = equityCurve[i];
    if (point.equity > peakEquity) {
      peakEquity = point.equity;
      peakIndex = i;
    }
    if (peakEquity > 0) {
      const drawdown = (peakEquity - point.equity) / peakEquity;
      if (drawdown > maxDrawdownPct) {
        maxDrawdownPct = drawdown;
        troughIndex = i;
        troughPeakEquity = peakEquity;
        peakAtMaxDrawdownIndex = peakIndex;
      }
    }
  }

  let recoveryIndex: number | null = null;
  for (let i = troughIndex + 1; i < equityCurve.length; i++) {
    if (equityCurve[i].equity >= troughPeakEquity) {
      recoveryIndex = i;
      break;
    }
  }

  const periodicReturns = equityCurve
    .slice(1)
    .map((point, index) => {
      const prior = equityCurve[index].equity;
      return prior > 0 ? point.equity / prior - 1 : 0;
    })
    .filter((value) => Number.isFinite(value));
  const volatility = sampleStdDev(periodicReturns);
  const startDate = equityCurve[0].date;
  const endDate = equityCurve[equityCurve.length - 1].date;

  return {
    startEquity: equityCurve[0].equity,
    endEquity: equityCurve[equityCurve.length - 1].equity,
    totalReturnPct:
      equityCurve[0].equity > 0 ? equityCurve[equityCurve.length - 1].equity / equityCurve[0].equity - 1 : 0,
    annualizedReturnPct: annualizedReturn(equityCurve[0].equity, equityCurve[equityCurve.length - 1].equity, startDate, endDate) ?? undefined,
    maxDrawdownPct,
    annualizedVolatilityPct: volatility === null ? null : volatility * annualizationFactor(barFrequency),
    peakDateBeforeMaxDrawdown: maxDrawdownPct > 0 ? equityCurve[peakAtMaxDrawdownIndex]?.date || undefined : undefined,
    troughDate: equityCurve[troughIndex]?.date || null,
    recoveryDate: recoveryIndex === null ? null : equityCurve[recoveryIndex]?.date || null,
    recoveryBars: recoveryIndex === null ? null : recoveryIndex - troughIndex,
    stepCount: equityCurve.length
  };
};

const resolveTargetSymbols = (provider: HistoricalMarketDataProvider, definition: BenchmarkDefinition) =>
  definition.targets.map((target) => {
    const candidates = [target.symbol, ...(target.fallbackSymbols || [])];
    const resolvedSymbol = candidates.find((symbol) => provider.getSeries(symbol).length > 0);
    if (!resolvedSymbol) {
      throw new Error(`Benchmark ${definition.id} requires ${target.symbol}, but no series or fallback was available.`);
    }
    return {
      requestedSymbol: target.symbol,
      resolvedSymbol,
      proxyUsed: resolvedSymbol !== target.symbol,
      weight: target.weight
    };
  });

const writeCsv = (filePath: string, header: string[], rows: string[][]) => {
  const escape = (value: string) => {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };
  const lines = [header.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
};

export const computeReplayPerformanceStats = (
  equityCurve: BenchmarkCurvePoint[],
  barFrequency: '1d' | '1w'
): BenchmarkSummaryStats => computeSummaryStats(equityCurve, barFrequency);

export const runReplayBenchmarks = async ({
  provider,
  dates,
  startingEquity,
  outputDir,
  barFrequency,
  asOfTime
}: {
  provider: HistoricalMarketDataProvider;
  dates: string[];
  startingEquity: number;
  outputDir: string;
  barFrequency: '1d' | '1w';
  asOfTime: string;
}): Promise<BenchmarkResult[]> => {
  const benchmarksDir = path.join(outputDir, 'benchmarks');
  fs.mkdirSync(benchmarksDir, { recursive: true });

  const results: BenchmarkResult[] = [];

  for (const definition of BENCHMARK_DEFINITIONS) {
    const resolvedTargets = resolveTargetSymbols(provider, definition);
    const holdings: Record<string, number> = {};
    let cash = startingEquity;
    let lastQuarterKey: string | null = null;
    const equityCurve: BenchmarkCurvePoint[] = [];
    const holdingsHistory: BenchmarkHoldingPoint[] = [];
    const orderLog: BenchmarkOrderLogEntry[] = [];

    for (const date of dates) {
      const asOf = `${date}${asOfTime}`;
      const prices = Object.fromEntries(
        await Promise.all(
          resolvedTargets.map(async (target) => [target.resolvedSymbol, (await provider.getQuote(target.resolvedSymbol, asOf)).price] as const)
        )
      );
      const holdingsValue = resolvedTargets.reduce(
        (sum, target) => sum + (holdings[target.resolvedSymbol] || 0) * (prices[target.resolvedSymbol] || 0),
        0
      );
      let equity = cash + holdingsValue;
      const currentQuarterKey = quarterKey(date);
      const shouldRebalance = !lastQuarterKey || currentQuarterKey !== lastQuarterKey;

      if (shouldRebalance && equity > 0) {
        const reason = lastQuarterKey ? 'quarterly_rebalance' : 'initial_allocation';
        const nextHoldings: Record<string, number> = {};
        for (const target of resolvedTargets) {
          const price = prices[target.resolvedSymbol] || 0;
          const targetValue = equity * target.weight;
          const targetQuantity = price > 0 ? targetValue / price : 0;
          const currentQuantity = holdings[target.resolvedSymbol] || 0;
          const deltaQuantity = targetQuantity - currentQuantity;
          const notionalUSD = Math.abs(deltaQuantity * price);
          if (Math.abs(deltaQuantity) > 1e-10 && notionalUSD > 1e-8) {
            orderLog.push({
              date,
              requestedSymbol: target.requestedSymbol,
              resolvedSymbol: target.resolvedSymbol,
              side: deltaQuantity >= 0 ? 'BUY' : 'SELL',
              notionalUSD,
              quantity: Math.abs(deltaQuantity),
              reason
            });
          }
          nextHoldings[target.resolvedSymbol] = targetQuantity;
        }
        Object.keys(holdings).forEach((symbol) => delete holdings[symbol]);
        Object.assign(holdings, nextHoldings);
        cash = 0;
        equity = resolvedTargets.reduce(
          (sum, target) => sum + (holdings[target.resolvedSymbol] || 0) * (prices[target.resolvedSymbol] || 0),
          0
        );
        lastQuarterKey = currentQuarterKey;
      }

      const snapshotHoldings = Object.fromEntries(
        Object.entries(holdings)
          .filter(([, quantity]) => Math.abs(quantity) > 1e-10)
          .sort(([a], [b]) => a.localeCompare(b))
      );
      equityCurve.push({ date, equity, cash });
      holdingsHistory.push({ date, holdings: snapshotHoldings, cash, equity });
    }

    const summaryStats = computeSummaryStats(equityCurve, barFrequency);
    const baseName = definition.id;
    const equityCurveCsv = path.join(benchmarksDir, `${baseName}_equity_curve.csv`);
    const holdingsHistoryJson = path.join(benchmarksDir, `${baseName}_holdings_history.json`);
    const orderLogJson = path.join(benchmarksDir, `${baseName}_order_log.json`);

    writeCsv(
      equityCurveCsv,
      ['date', 'equity', 'cash'],
      equityCurve.map((point) => [point.date, point.equity.toFixed(6), point.cash.toFixed(6)])
    );
    fs.writeFileSync(holdingsHistoryJson, JSON.stringify(holdingsHistory, null, 2));
    fs.writeFileSync(orderLogJson, JSON.stringify(orderLog, null, 2));

    results.push({
      id: definition.id,
      label: definition.label,
      rebalancePolicy: definition.rebalancePolicy,
      assumptions: [
        ...definition.assumptions,
        'Fractional shares, zero transaction costs, and zero slippage.',
        ...resolvedTargets
          .filter((target) => target.proxyUsed)
          .map((target) => `${target.requestedSymbol} used ${target.resolvedSymbol} because the replay input did not contain ${target.requestedSymbol}.`)
      ],
      resolvedSymbols: resolvedTargets.map((target) => ({
        requestedSymbol: target.requestedSymbol,
        resolvedSymbol: target.resolvedSymbol,
        proxyUsed: target.proxyUsed
      })),
      equityCurve,
      holdingsHistory,
      orderLog,
      summaryStats,
      outputFiles: {
        equityCurveCsv,
        holdingsHistoryJson,
        orderLogJson
      }
    });
  }

  return results;
};
