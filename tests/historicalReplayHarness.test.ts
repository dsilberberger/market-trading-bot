import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OptionPosition } from '../src/core/types';
import { BenchmarkSummaryStats } from '../src/replay/benchmarkPortfolios';
import { buildValidationArtifacts } from '../src/replay/validationArtifacts';
import { HistoricalReplayInput, HistoricalReplayResult, runHistoricalReplay } from '../src/replay/runHistoricalReplay';

const UNIVERSE = ['VTI', 'VXUS', 'VTV', 'USMV', 'SHY', 'IEF', 'TIP'];

const tmpDirs: string[] = [];
const runDirs = new Set<string>();

const weeklyDates = (count: number, start = '2024-01-03') => {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return dates;
};

const assetReturn = (symbol: string, anchorReturn: number) => {
  if (symbol === 'VTI') return anchorReturn;
  if (symbol === 'VXUS') return anchorReturn * 0.85;
  if (symbol === 'USMV') return anchorReturn * 0.65;
  if (symbol === 'VTV') return anchorReturn * 0.75;
  if (symbol === 'SHY') return anchorReturn < 0 ? 0.0002 : 0.00005;
  if (symbol === 'IEF') return anchorReturn < 0 ? 0.0008 : -0.0002;
  if (symbol === 'TIP') return anchorReturn * 0.35;
  return anchorReturn;
};

const buildSeries = (anchorReturns: number[]) => {
  const dates = weeklyDates(anchorReturns.length + 1);
  const prices: Record<string, number> = {
    VTI: 100,
    VXUS: 60,
    VTV: 80,
    USMV: 70,
    SHY: 82,
    IEF: 95,
    TIP: 110
  };
  const series = Object.fromEntries(
    UNIVERSE.map((symbol) => [symbol, [{ date: dates[0], close: prices[symbol] }]])
  ) as HistoricalReplayInput['series'];

  for (let i = 1; i < dates.length; i++) {
    const anchorReturn = anchorReturns[i - 1];
    for (const symbol of UNIVERSE) {
      prices[symbol] = prices[symbol] * (1 + assetReturn(symbol, anchorReturn));
      series[symbol].push({ date: dates[i], close: Number(prices[symbol].toFixed(6)) });
    }
  }

  return { dates, series };
};

const makeOutputDir = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
};

const buildInput = (anchorReturns: number[], startIndex: number, endIndex: number): HistoricalReplayInput => {
  const { dates, series } = buildSeries(anchorReturns);
  return {
    series,
    universe: UNIVERSE,
    calendarSymbol: 'VTI',
    barFrequency: '1w',
    dateRange: {
      start: dates[startIndex],
      end: dates[endIndex]
    },
    startingCash: 5000
  };
};

const writeReplayConfig = (name: string, mutate?: (config: any) => void) => {
  const dir = makeOutputDir(name);
  const configPath = path.join(dir, 'config.json');
  const config = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/config/default.small.json'), 'utf-8')
  );
  if (mutate) mutate(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
};

const collectRunDirs = (result: HistoricalReplayResult) => {
  result.steps.forEach((step) => runDirs.add(step.artifactDir));
};

const collectRunDirsByPrefix = (prefix: string) => {
  const runsDir = path.resolve(process.cwd(), 'runs');
  if (!fs.existsSync(runsDir)) return;
  for (const entry of fs.readdirSync(runsDir)) {
    if (entry.startsWith(prefix)) runDirs.add(path.join(runsDir, entry));
  }
};

const makeStrategyPerformance = (): BenchmarkSummaryStats => ({
  startEquity: 1000,
  endEquity: 1025,
  totalReturnPct: 0.025,
  annualizedReturnPct: 0.025,
  maxDrawdownPct: 0.1,
  annualizedVolatilityPct: 0.12,
  peakDateBeforeMaxDrawdown: '2024-01-03',
  troughDate: '2024-01-10',
  recoveryDate: null,
  recoveryBars: null,
  stepCount: 2
});

const normalizeResult = (result: HistoricalReplayResult) => ({
  steps: result.steps.map((step) => ({
    date: step.date,
    regime: step.regime,
    confidence: step.confidence,
    exposureCap: step.exposureCap,
    deployBudgetUsd: step.deployBudgetUsd,
    targetAllocations: step.targetAllocations,
    achievedAllocations: step.achievedAllocations,
    orders: step.orders,
    holdingsAfterExecution: step.holdingsAfterExecution,
    optionCashEvents: step.optionCashEvents,
    capitalLanes: step.capitalLanes,
    executedOptionReserveUsageUsd: step.executedOptionReserveUsageUsd,
    executedReserveUsageUsd: step.executedReserveUsageUsd,
    reserveUsageUsd: step.reserveUsageUsd,
    plannedOptionReserveStateUsd: step.plannedOptionReserveStateUsd,
    plannedOptionReserveStateBySleeve: step.plannedOptionReserveStateBySleeve,
    sleeveTriggerEvents: step.sleeveTriggerEvents,
    dislocationState: step.dislocationState
  })),
  equityCurve: result.equityCurve,
  holdingsHistory: result.holdingsHistory,
  optionPositionsHistory: result.optionPositionsHistory,
  orderLog: result.orderLog,
  optionCashEventLog: result.optionCashEventLog,
  sleeveEventLog: result.sleeveEventLog,
  validationSummary: result.validationSummary,
  portfolioSummaryRows: result.portfolioSummaryRows,
  strategyDiagnostics: result.strategyDiagnostics,
  summaryStats: result.summaryStats
});

const insurancePosition = (positions: OptionPosition[] | undefined) =>
  (positions || []).find((position) => position.type === 'PUT');

const growthPosition = (positions: OptionPosition[] | undefined) =>
  (positions || []).find((position) => position.type === 'CALL');

describe('historical replay harness', () => {
  afterAll(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of runDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps planned option sleeve state separate from executed reserve metrics in validation artifacts', () => {
    const outputDir = makeOutputDir('replay-validation-accounting');
    const steps = [
      {
        date: '2024-01-03',
        asOf: '2024-01-03T16:00',
        runId: 'replay-validation-accounting-2024-01-03',
        runStatus: 'completed' as const,
        regime: 'risk_off',
        confidence: 0.5,
        exposureCap: 0.2,
        deployBudgetUsd: 200,
        targetAllocations: {},
        achievedAllocations: {},
        orders: [],
        holdingsAfterExecution: { cash: 800, equity: 1000, holdings: [] },
        optionCashEvents: [],
        capitalLanes: {
          coreCapitalUsd: 700,
          coreCashUsd: 100,
          coreHeadroomUsd: 100,
          executedDislocationCoreUsageUsd: 250,
          optionsReserveCapitalUsd: 300,
          optionsReserveCashUsd: 150,
          optionsReserveHeadroomUsd: 150
        },
        executedOptionReserveUsageUsd: 0,
        executedReserveUsageUsd: 0,
        reserveUsageUsd: 0,
        plannedOptionReserveStateUsd: 40,
        plannedOptionReserveStateBySleeve: {
          insurancePremiumStateUsd: 25,
          growthPremiumStateUsd: 15
        },
        sleeveTriggerEvents: [],
        dislocationState: {},
        artifactDir: outputDir
      },
      {
        date: '2024-01-10',
        asOf: '2024-01-10T16:00',
        runId: 'replay-validation-accounting-2024-01-10',
        runStatus: 'completed' as const,
        regime: 'neutral',
        confidence: 0.55,
        exposureCap: 0.5,
        deployBudgetUsd: 300,
        targetAllocations: {},
        achievedAllocations: {},
        orders: [],
        holdingsAfterExecution: { cash: 825, equity: 1025, holdings: [] },
        optionCashEvents: [],
        capitalLanes: {
          coreCapitalUsd: 717.5,
          coreCashUsd: 125,
          coreHeadroomUsd: 125,
          executedDislocationCoreUsageUsd: 0,
          optionsReserveCapitalUsd: 307.5,
          optionsReserveCashUsd: 200,
          optionsReserveHeadroomUsd: 200
        },
        executedOptionReserveUsageUsd: 0,
        executedReserveUsageUsd: 0,
        reserveUsageUsd: 0,
        plannedOptionReserveStateUsd: 10,
        plannedOptionReserveStateBySleeve: {
          insurancePremiumStateUsd: 10,
          growthPremiumStateUsd: 0
        },
        sleeveTriggerEvents: [],
        dislocationState: {},
        artifactDir: outputDir
      }
    ];

    const artifacts = buildValidationArtifacts({
      input: {
        series: {},
        dateRange: { start: '2024-01-03', end: '2024-01-10' },
        barFrequency: '1w'
      },
      outputDir,
      runPrefix: 'replay-validation-accounting',
      steps,
      strategyEquityCurve: [
        { date: '2024-01-03', equity: 1000, cash: 800 },
        { date: '2024-01-10', equity: 1025, cash: 825 }
      ],
      strategyPerformance: makeStrategyPerformance(),
      strategyOrderLog: [],
      sleeveEventLog: [],
      benchmarkResults: []
    });

    expect(artifacts.strategyDiagnostics.reserveUsageSummary.accountingScope).toBe('executed_replay_only');
    expect(artifacts.strategyDiagnostics.reserveUsageSummary.peakReserveUsageUsd).toBe(0);
    expect(artifacts.strategyDiagnostics.reserveUsageSummary.averageReserveUsageUsd).toBe(0);
    expect(artifacts.strategyDiagnostics.coreLaneSummary.peakDislocationCoreUsageUsd).toBe(250);
    expect(artifacts.strategyDiagnostics.plannedOptionSleeveStateSummary.accountingScope).toBe(
      'planned_non_executed_option_state'
    );
    expect(artifacts.strategyDiagnostics.plannedOptionSleeveStateSummary.peakPlannedOptionReserveStateUsd).toBe(40);
    expect(artifacts.strategyDiagnostics.plannedOptionSleeveStateSummary.averagePlannedOptionReserveStateUsd).toBe(25);
    expect(artifacts.validationSummary.strategy.reserveMetrics.peakReserveUsageUsd).toBe(0);
    expect(artifacts.validationSummary.strategy.coreLaneMetrics.peakDislocationCoreUsageUsd).toBe(250);
    expect(artifacts.validationSummary.strategy.plannedOptionSleeveState.peakPlannedOptionReserveStateUsd).toBe(40);
  });

  it(
    'does not look ahead when future bars are present',
    async () => {
      const warmup = Array(38).fill(0.004);
      const truncatedInput = buildInput(warmup, 34, 34);
      const extendedInput = buildInput([...warmup, -0.25, 0.3], 34, 34);

      const truncated = await runHistoricalReplay({
        input: truncatedInput,
        configPath: writeReplayConfig('replay-no-lookahead-config'),
        outputDir: makeOutputDir('replay-no-lookahead-a'),
        runPrefix: 'replay-no-lookahead'
      });
      const extended = await runHistoricalReplay({
        input: extendedInput,
        configPath: writeReplayConfig('replay-no-lookahead-config-b'),
        outputDir: makeOutputDir('replay-no-lookahead-b'),
        runPrefix: 'replay-no-lookahead'
      });

      collectRunDirs(truncated);
      collectRunDirs(extended);

      expect(truncated.steps).toHaveLength(1);
      expect(extended.steps).toHaveLength(1);
      expect(normalizeResult(truncated).steps[0]).toEqual(normalizeResult(extended).steps[0]);
    },
    60000
  );

  it(
    'carries holdings state forward across replay steps',
    async () => {
      const returns = Array(36).fill(0.004).concat([0, 0]);
      const result = await runHistoricalReplay({
        input: buildInput(returns, 35, 37),
        configPath: writeReplayConfig('replay-carry-forward-config'),
        outputDir: makeOutputDir('replay-carry-forward'),
        runPrefix: 'replay-carry-forward'
      });

      collectRunDirs(result);

      expect(result.steps[0].orders.some((order) => order.side === 'BUY')).toBe(true);
      expect(result.steps[0].holdingsAfterExecution.holdings.length).toBeGreaterThan(0);
      expect(result.steps[1].orders).toHaveLength(0);
      expect(result.steps[1].holdingsAfterExecution.holdings).toEqual(result.steps[0].holdingsAfterExecution.holdings);
    },
    60000
  );

  it(
    'produces identical outputs on repeated runs',
    async () => {
      const returns = Array(36).fill(0.004).concat([0, 0]);
      const input = buildInput(returns, 35, 37);

      const first = await runHistoricalReplay({
        input,
        configPath: writeReplayConfig('replay-repeat-config-a'),
        outputDir: makeOutputDir('replay-repeat-a'),
        runPrefix: 'replay-repeatable'
      });
      const second = await runHistoricalReplay({
        input,
        configPath: writeReplayConfig('replay-repeat-config-b'),
        outputDir: makeOutputDir('replay-repeat-b'),
        runPrefix: 'replay-repeatable'
      });

      collectRunDirs(first);
      collectRunDirs(second);

      expect(normalizeResult(first)).toEqual(normalizeResult(second));
    },
    60000
  );

  it(
    'persists sleeve trigger state across replay steps',
    async () => {
      const returns = Array(34)
        .fill(0.004)
        .concat([-0.09, -0.08, -0.06, -0.02, 0.01, 0.005]);
      const configPath = writeReplayConfig('replay-sleeve-config', (config) => {
        config.maxWeeklyDrawdownPct = 0.5;
        config.dislocation = {
          ...(config.dislocation || {}),
          minActiveTier: 1,
          earlyExit: {
            ...(config.dislocation?.earlyExit || {}),
            enabled: false
          }
        };
      });
      const result = await runHistoricalReplay({
        input: buildInput(returns, 34, 40),
        configPath,
        outputDir: makeOutputDir('replay-sleeve'),
        runPrefix: 'replay-sleeve'
      });

      collectRunDirs(result);

      const triggerIndex = result.steps.findIndex((step) => {
        const state = step.dislocationState || {};
        return state.phase && state.phase !== 'INACTIVE';
      });
      expect(triggerIndex).toBeGreaterThanOrEqual(0);
      expect(result.sleeveEventLog.length).toBeGreaterThan(0);
      const triggerState = result.steps[triggerIndex].dislocationState || {};
      expect(triggerState.phase).toBeTruthy();
      if (triggerIndex + 1 < result.steps.length) {
        const nextState = result.steps[triggerIndex + 1].dislocationState || {};
        expect(
          nextState.phase === triggerState.phase ||
            nextState.phase === 'HOLD' ||
            nextState.phase === 'REINTEGRATE' ||
            nextState.triggeredAtISO === triggerState.triggeredAtISO ||
            nextState.lastTierChangeISO === triggerState.lastTierChangeISO
        ).toBe(true);
      }
    },
    60000
  );

  it(
    'uses replay-clock timestamps for replay state and ledger events',
    async () => {
      const returns = Array(34).fill(0.004).concat([-0.25, 0.01, 0.01]);
      const prefix = 'replay-clock';
      const result = await runHistoricalReplay({
        input: {
          ...buildInput(returns, 34, 36),
          startingCash: 50000
        },
        configPath: writeReplayConfig('replay-clock-config', (config) => {
          config.dislocation = {
            ...(config.dislocation || {}),
            minActiveTier: 1
          };
        }),
        outputDir: makeOutputDir('replay-clock'),
        runPrefix: prefix
      });

      collectRunDirs(result);
      collectRunDirsByPrefix(prefix);

      const detectorState = JSON.parse(
        fs.readFileSync(path.join(result.outputDir, 'state', 'dislocation_state.json'), 'utf-8')
      );
      const ledgerEvents = fs
        .readFileSync(path.join(result.outputDir, 'ledger', 'events.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      expect(detectorState.windowStartISO.startsWith('2024-')).toBe(true);
      expect(detectorState.expiresISO.startsWith('2024-')).toBe(true);
      expect(ledgerEvents[0].timestamp.startsWith('2024-')).toBe(true);
    },
    60000
  );

  it(
    'emits sleeve-funded buys and carries reserve usage forward across replay steps',
    async () => {
      const returns = Array(34).fill(0.004).concat([-0.25, 0.01, 0.005, 0.002]);
      const prefix = 'replay-reserve-carry';
      const result = await runHistoricalReplay({
        input: {
          ...buildInput(returns, 34, 37),
          startingCash: 50000
        },
        configPath: writeReplayConfig('replay-reserve-carry-config', (config) => {
          config.maxWeeklyDrawdownPct = 1;
          config.maxTradesPerRun = 20;
          config.dislocation = {
            ...(config.dislocation || {}),
            minActiveTier: 1,
            durationWeeksAdd: 0,
            durationWeeksHold: 4,
            earlyExit: {
              ...(config.dislocation?.earlyExit || {}),
              enabled: false
            }
          };
        }),
        outputDir: makeOutputDir('replay-reserve-carry'),
        runPrefix: prefix
      });

      collectRunDirs(result);
      collectRunDirsByPrefix(prefix);

      const triggerIndex = result.steps.findIndex((step) =>
        step.sleeveTriggerEvents.some((event) => event.code === 'DISLOCATION_SLEEVE_TRIGGERED')
      );

      expect(triggerIndex).toBeGreaterThanOrEqual(0);
      if (triggerIndex < 0) return;

      const triggerStep = result.steps[triggerIndex];
      const nextStep = result.steps[triggerIndex + 1];

      expect(triggerStep.orders.some((order) => order.side === 'BUY' && order.sleeve === 'dislocation')).toBe(true);
      expect(triggerStep.executedReserveUsageUsd).toBe(triggerStep.reserveUsageUsd);
      expect(triggerStep.capitalLanes.executedDislocationCoreUsageUsd).toBeGreaterThan(0);
      expect(triggerStep.plannedOptionReserveStateUsd).toBeGreaterThanOrEqual(0);
      expect(nextStep).toBeDefined();
      if (!nextStep) return;
      expect(nextStep.orders.some((order) => order.side === 'BUY' && order.sleeve === 'dislocation')).toBe(false);
      expect(nextStep.executedReserveUsageUsd).toBe(nextStep.reserveUsageUsd);
      expect(nextStep.capitalLanes.executedDislocationCoreUsageUsd).toBeGreaterThan(0);
    },
    60000
  );

  it(
    'opens replay insurance option positions only under active severe dislocation and includes them in equity and reserve usage',
    async () => {
      const returns = Array(34).fill(0.004).concat([-0.08, -0.3, -0.18, -0.04, 0.01]);
      const prefix = 'replay-insurance-option-open-confirmed';
      const result = await runHistoricalReplay({
        input: {
          ...buildInput(returns, 34, 38),
          startingCash: 50000
        },
        configPath: writeReplayConfig('replay-insurance-option-open-confirmed-config', (config) => {
          config.maxWeeklyDrawdownPct = 1;
          config.capital = {
            ...(config.capital || {}),
            baseDeployPct: {
              risk_off: 0.05,
              neutral: 0.05,
              risk_on: 0.05,
              fallback: 0.05
            }
          };
          config.dislocation = {
            ...(config.dislocation || {}),
            minActiveTier: 1,
            earlyExit: {
              ...(config.dislocation?.earlyExit || {}),
              enabled: false
            }
          };
        }),
        outputDir: makeOutputDir('replay-insurance-option-open'),
        runPrefix: prefix
      });

      collectRunDirs(result);
      collectRunDirsByPrefix(prefix);

      const openStep = result.steps.find((step) =>
        step.optionCashEvents.some((event) => event.type === 'OPT_OPEN_DEBIT' && event.sleeve === 'insurance')
      );
      expect(openStep).toBeDefined();
      if (!openStep) return;
      const openIndex = result.steps.findIndex((step) => step.runId === openStep.runId);
      const preOpenSteps = result.steps.slice(0, openIndex);

      const position = insurancePosition(openStep.holdingsAfterExecution.optionPositions);
      expect(position).toBeDefined();
      if (!position) return;

      expect(
        preOpenSteps.every((step) =>
          step.optionCashEvents.every((event) => event.type !== 'OPT_OPEN_DEBIT' || event.sleeve !== 'insurance')
        )
      ).toBe(true);
      expect(openStep.dislocationState?.active).toBe(true);
      expect(['ADD', 'HOLD']).toContain(openStep.dislocationState?.phase);
      expect(openStep.dislocationState?.currentTier ?? 0).toBeGreaterThanOrEqual(2);
      expect(openStep.executedOptionReserveUsageUsd).toBeGreaterThan(0);
      expect(openStep.executedReserveUsageUsd).toBeCloseTo(openStep.executedOptionReserveUsageUsd, 6);
      expect(openStep.holdingsAfterExecution.optionsMarketValueUsd).toBeGreaterThan(0);
      expect(openStep.holdingsAfterExecution.equity).toBeGreaterThan(openStep.holdingsAfterExecution.cash);
      expect(result.optionPositionsHistory.some((entry) => entry.optionPositions.length > 0)).toBe(true);
      expect(result.optionCashEventLog.some((event) => event.type === 'OPT_OPEN_DEBIT' && event.sleeve === 'insurance')).toBe(true);
      expect(
        Math.abs(
          openStep.optionCashEvents.find((event) => event.type === 'OPT_OPEN_DEBIT' && event.sleeve === 'insurance')?.amount || 0
        )
      ).toBeLessThan(openStep.holdingsAfterExecution.equity * 0.05);
    },
    60000
  );

  it(
    'expires replay insurance options on the replay clock',
    async () => {
      const returns = Array(34).fill(0.004).concat([-0.3, -0.18, -0.02, 0.005]);
      const prefix = 'replay-insurance-option-expire-confirmed';
      const result = await runHistoricalReplay({
        input: {
          ...buildInput(returns, 34, 37),
          startingCash: 50000
        },
        configPath: writeReplayConfig('replay-insurance-option-expire-confirmed-config', (config) => {
          config.maxWeeklyDrawdownPct = 1;
          config.capital = {
            ...(config.capital || {}),
            baseDeployPct: {
              risk_off: 0.05,
              neutral: 0.05,
              risk_on: 0.05,
              fallback: 0.05
            }
          };
          config.dislocation = {
            ...(config.dislocation || {}),
            minActiveTier: 1,
            earlyExit: {
              ...(config.dislocation?.earlyExit || {}),
              enabled: false
            }
          };
          config.insurance = {
            ...(config.insurance || {}),
            minMonths: 0,
            maxMonths: 0,
            allowExpire: true,
            closeWithinDays: 0
          };
        }),
        outputDir: makeOutputDir('replay-insurance-option-expire'),
        runPrefix: prefix
      });

      collectRunDirs(result);
      collectRunDirsByPrefix(prefix);

      const expireStep = result.steps.find((step) => step.optionCashEvents.some((event) => event.type === 'OPT_EXPIRE'));
      expect(expireStep).toBeDefined();
      if (!expireStep) return;
      const remainingPosition = insurancePosition(expireStep.holdingsAfterExecution.optionPositions);
      if (remainingPosition) {
        expect(remainingPosition.openDate).toBe(expireStep.asOf);
        expect(expireStep.optionCashEvents.some((event) => event.type === 'OPT_OPEN_DEBIT')).toBe(true);
      } else {
        expect(expireStep.executedOptionReserveUsageUsd).toBe(0);
      }
      expect(result.optionCashEventLog.some((event) => event.type === 'OPT_EXPIRE')).toBe(true);
    },
    60000
  );

  it(
    'opens replay growth options during robust risk_on periods',
    async () => {
      const returns = Array(40).fill(0.008);
      const prefix = 'replay-growth-option-open';
      const result = await runHistoricalReplay({
        input: {
          ...buildInput(returns, 35, 39),
          startingCash: 20000
        },
        configPath: writeReplayConfig('replay-growth-option-open-config', (config) => {
          config.maxWeeklyDrawdownPct = 1;
          config.capital = {
            ...(config.capital || {}),
            corePct: 0.7,
            reservePct: 0.3,
            baseDeployPct: {
              risk_off: 0.2,
              neutral: 0.3,
              risk_on: 0.4,
              fallback: 0.3
            }
          };
          config.growth = {
            ...(config.growth || {}),
            spendPct: 0.18,
            minMonths: 2,
            maxMonths: 3,
            minMoneyness: 1.03,
            maxMoneyness: 1.05,
            allowExpire: false,
            closeWithinDays: 14
          };
        }),
        outputDir: makeOutputDir('replay-growth-option-open'),
        runPrefix: prefix
      });

      collectRunDirs(result);
      collectRunDirsByPrefix(prefix);

      const openStep = result.steps.find((step) =>
        step.optionCashEvents.some((event) => event.type === 'OPT_OPEN_DEBIT' && event.sleeve === 'growth')
      );
      expect(openStep).toBeDefined();
      if (!openStep) return;

      const position = growthPosition(openStep.holdingsAfterExecution.optionPositions);
      expect(position).toBeDefined();
      if (!position) return;

      expect(openStep.regime).toBe('risk_on');
      expect((openStep.confidence || 0)).toBeGreaterThanOrEqual(0.6);
      expect(openStep.dislocationState?.active).not.toBe(true);
      expect(position.type).toBe('CALL');
      expect(openStep.executedOptionReserveUsageUsd).toBeGreaterThan(0);
      expect(openStep.holdingsAfterExecution.optionsMarketValueUsd).toBeGreaterThan(0);
      expect(
        result.optionCashEventLog.some((event) => event.type === 'OPT_OPEN_DEBIT' && event.sleeve === 'growth')
      ).toBe(true);
    },
    60000
  );

  it(
    'supports pre-roll warm-start and otherwise marks insufficient-history steps as warmup',
    async () => {
      const warmupOnly = await runHistoricalReplay({
        input: buildInput(Array(25).fill(0.004), 0, 1),
        configPath: writeReplayConfig('replay-warmup-only-config'),
        outputDir: makeOutputDir('replay-warmup-only'),
        runPrefix: 'replay-warmup-only'
      });

      const returns = Array(38).fill(0.004).concat([0, 0]);
      const input = buildInput(returns, 35, 37);
      const prefixNoPreRoll = 'replay-preroll-off';
      const prefixPreRoll = 'replay-preroll-on';

      const withoutPreRoll = await runHistoricalReplay({
        input,
        configPath: writeReplayConfig('replay-warmup-no-preroll-config'),
        outputDir: makeOutputDir('replay-warmup-no-preroll'),
        runPrefix: prefixNoPreRoll
      });
      const withPreRoll = await runHistoricalReplay({
        input: {
          ...input,
          preRollBars: 10
        },
        configPath: writeReplayConfig('replay-warmup-preroll-config'),
        outputDir: makeOutputDir('replay-warmup-preroll'),
        runPrefix: prefixPreRoll
      });

      collectRunDirs(withoutPreRoll);
      collectRunDirs(withPreRoll);
      collectRunDirs(warmupOnly);
      collectRunDirsByPrefix('replay-warmup-only');
      collectRunDirsByPrefix(prefixNoPreRoll);
      collectRunDirsByPrefix(prefixPreRoll);

      expect(warmupOnly.steps[0].runStatus).toBe('warmup');
      expect(withoutPreRoll.steps[0].runStatus).toBe('completed');
      expect(withPreRoll.steps[0].runStatus).toBe('completed');
      expect(withoutPreRoll.steps[0].orders.some((order) => order.side === 'BUY')).toBe(true);
      expect(withPreRoll.steps[0].orders).toHaveLength(0);
      expect(withPreRoll.steps[0].holdingsAfterExecution.holdings.length).toBeGreaterThan(0);
    },
    60000
  );

  it(
    'produces standardized validation artifacts alongside benchmark and strategy replay outputs',
    async () => {
      const result = await runHistoricalReplay({
        input: buildInput(Array(36).fill(0.004), 35, 37),
        configPath: writeReplayConfig('replay-benchmarks-config'),
        outputDir: makeOutputDir('replay-benchmarks'),
        runPrefix: 'replay-benchmarks'
      });

      collectRunDirs(result);
      collectRunDirsByPrefix('replay-benchmarks');

      expect(result.benchmarkResults).toHaveLength(3);
      expect(result.performanceComparison.map((row) => row.label)).toEqual(
        expect.arrayContaining([
          'Current Strategy',
          '60/40 (VTI/BND)',
          '80/20 (VTI/BND)',
          '100% Equity (VTI/VXUS)'
        ])
      );
      for (const benchmark of result.benchmarkResults) {
        expect(fs.existsSync(benchmark.outputFiles.equityCurveCsv)).toBe(true);
        expect(benchmark.summaryStats.stepCount).toBe(result.steps.length);
      }
      expect(fs.existsSync(path.join(result.outputDir, 'performance_comparison.csv'))).toBe(true);
      expect(fs.existsSync(path.join(result.outputDir, 'strategy_equity_curve.csv'))).toBe(true);
      expect(fs.existsSync(path.join(result.outputDir, 'validation_summary.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.outputDir, 'validation_portfolio_summary.csv'))).toBe(true);
      expect(fs.existsSync(path.join(result.outputDir, 'strategy_diagnostics.json'))).toBe(true);
      expect(result.validationSummary.metadata.runPrefix).toBe('replay-benchmarks');
      expect(result.validationSummary.metadata.benchmarkNames).toEqual(
        expect.arrayContaining(['60/40 (VTI/BND)', '80/20 (VTI/BND)', '100% Equity (VTI/VXUS)'])
      );
      expect(result.validationSummary.portfolios).toHaveLength(4);
      expect(result.portfolioSummaryRows.find((row) => row.portfolio === 'Current Strategy')?.tradeCount).toBeGreaterThanOrEqual(0);
      expect(result.strategyDiagnostics.regimeDistribution.counts.risk_on).toBeGreaterThanOrEqual(0);
      expect(result.strategyDiagnostics.reserveUsageSummary.accountingScope).toBe('executed_replay_only');
      expect(result.strategyDiagnostics.coreLaneSummary.averageDislocationCoreUsageUsd).toBeGreaterThanOrEqual(0);
      expect(result.strategyDiagnostics.plannedOptionSleeveStateSummary.accountingScope).toBe(
        'planned_non_executed_option_state'
      );
      expect(result.validationSummary.strategy.plannedOptionSleeveState).toBeDefined();
      expect(result.strategyDiagnostics.tradeSummary.grossTradedNotionalUsd).toBeGreaterThanOrEqual(0);
    },
    60000
  );
});
