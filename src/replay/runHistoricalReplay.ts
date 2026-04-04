import fs from 'fs';
import path from 'path';
import { BotConfig, MacroSeries, OptionCashEvent, OptionPosition, PortfolioState, TradeOrder } from '../core/types';
import { computeCapitalLanes, computeOptionReserveUsageUsd } from '../core/capital';
import { ensureDir, loadConfig, writeJSONFile } from '../core/utils';
import { HistoricalMarketDataProvider, HistoricalReplayBar } from './historicalMarketData';
import {
  BenchmarkResult,
  computeReplayPerformanceStats,
  runReplayBenchmarks
} from './benchmarkPortfolios';
import {
  buildValidationArtifacts,
  StrategyDiagnostics,
  ValidationPortfolioSummaryRow,
  ValidationSummaryArtifact,
  writeValidationArtifacts
} from './validationArtifacts';
import { ReplayBroker } from './replayBroker';
import { runBot } from '../cli/run';
import { loadInsuranceState, saveInsuranceState } from '../sleeves/insuranceSleeve';
import { loadGrowthState, saveGrowthState } from '../sleeves/growthSleeve';

export interface HistoricalReplayInput {
  series: Record<string, HistoricalReplayBar[]>;
  dateRange: {
    start: string;
    end: string;
  };
  barFrequency: '1d' | '1w';
  universe?: string[];
  calendarSymbol?: string;
  asOfTime?: string;
  lookbackDays?: number;
  preRollBars?: number;
  macroSeries?: MacroSeries[];
  startingCash?: number;
  startingHoldings?: PortfolioState['holdings'];
  startingPortfolio?: Partial<PortfolioState>;
}

export interface HistoricalReplayOptions {
  input: HistoricalReplayInput;
  configPath?: string;
  outputDir?: string;
  runPrefix?: string;
  strategy?: 'deterministic' | 'random' | 'llm';
}

export interface ReplayStepSummary {
  date: string;
  asOf: string;
  runId: string;
  runStatus: 'completed' | 'warmup';
  regime: string | null;
  confidence: number | null;
  exposureCap: number | null;
  deployBudgetUsd: number | null;
  targetAllocations: Record<string, number>;
  achievedAllocations: Record<string, number>;
  orders: TradeOrder[];
  holdingsAfterExecution: PortfolioState;
  optionCashEvents: OptionCashEvent[];
  capitalLanes: {
    coreCapitalUsd: number;
    coreCashUsd: number;
    coreHeadroomUsd: number;
    executedDislocationCoreUsageUsd: number;
    optionsReserveCapitalUsd: number;
    optionsReserveCashUsd: number;
    optionsReserveHeadroomUsd: number;
  };
  executedOptionReserveUsageUsd: number;
  executedReserveUsageUsd: number;
  reserveUsageUsd: number;
  plannedOptionReserveStateUsd: number;
  plannedOptionReserveStateBySleeve: {
    insurancePremiumStateUsd: number;
    growthPremiumStateUsd: number;
  };
  sleeveTriggerEvents: Array<{ code: string; message: string; observed?: any }>;
  dislocationState: any;
  artifactDir: string;
}

export interface HistoricalReplayResult {
  outputDir: string;
  runPrefix: string;
  stepRunIds: string[];
  steps: ReplayStepSummary[];
  equityCurve: Array<{ date: string; equity: number; cash: number }>;
  holdingsHistory: Array<{ date: string; holdings: PortfolioState['holdings']; cash: number; equity: number }>;
  optionPositionsHistory: Array<{ date: string; optionPositions: OptionPosition[]; optionsMarketValueUsd: number }>;
  orderLog: Array<{ date: string; runId: string; order: TradeOrder }>;
  optionCashEventLog: OptionCashEvent[];
  sleeveEventLog: Array<{ date: string; runId: string; code: string; message: string; observed?: any }>;
  benchmarkResults: BenchmarkResult[];
  performanceComparison: Array<{
    label: string;
    type: 'strategy' | 'benchmark';
    startEquity: number;
    endEquity: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    annualizedVolatilityPct: number | null;
    annualizedReturnPct?: number;
    turnoverPct?: number;
    peakDateBeforeMaxDrawdown?: string;
    troughDate?: string;
    recoveryDate: string | null;
    recoveryBars: number | null;
  }>;
  validationSummary: ValidationSummaryArtifact;
  portfolioSummaryRows: ValidationPortfolioSummaryRow[];
  strategyDiagnostics: StrategyDiagnostics;
  summaryStats: {
    startEquity: number;
    endEquity: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    stepCount: number;
  };
}

const readJson = <T>(filePath: string, fallback: T): T => {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
};

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

const filterMacroSeries = (series: MacroSeries[] | undefined, date: string): MacroSeries[] | undefined => {
  if (!series) return undefined;
  return series.map((entry) => ({
    ...entry,
    points: (entry.points || []).filter((point) => point.date <= date)
  }));
};

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');

const resolveStartingPortfolio = (input: HistoricalReplayInput, config: BotConfig): PortfolioState => {
  const base = input.startingPortfolio || {};
  const cash = base.cash ?? input.startingCash ?? config.startingCapitalUSD;
  const holdings = base.holdings ?? input.startingHoldings ?? [];
  const impliedHoldingsEquity = holdings.reduce((sum, holding) => sum + holding.quantity * (holding.avgPrice || 0), 0);
  return {
    cash,
    holdings,
    equity: base.equity ?? cash + impliedHoldingsEquity
  };
};

const buildReplayDates = (
  provider: HistoricalMarketDataProvider,
  input: HistoricalReplayInput,
  universe: string[]
): { executionDates: string[]; recordedDates: Set<string> } => {
  const calendarSymbol = input.calendarSymbol || universe[0];
  if (!calendarSymbol) return { executionDates: [], recordedDates: new Set<string>() };
  const series = provider.getSeries(calendarSymbol);
  const allDates = series.map((bar) => bar.date);
  let endIndex = -1;
  for (let i = allDates.length - 1; i >= 0; i--) {
    if (allDates[i] <= input.dateRange.end) {
      endIndex = i;
      break;
    }
  }
  const startIndex = allDates.findIndex((date) => date >= input.dateRange.start);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return { executionDates: [], recordedDates: new Set<string>() };
  }
  const preRollBars = Math.max(0, input.preRollBars ?? 0);
  const executionStartIndex = Math.max(0, startIndex - preRollBars);
  return {
    executionDates: allDates.slice(executionStartIndex, endIndex + 1),
    recordedDates: new Set(allDates.slice(startIndex, endIndex + 1))
  };
};

const computeSummaryStats = (equityCurve: Array<{ date: string; equity: number; cash: number }>) => {
  if (!equityCurve.length) {
    return { startEquity: 0, endEquity: 0, totalReturnPct: 0, maxDrawdownPct: 0, stepCount: 0 };
  }
  let peak = equityCurve[0].equity;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.equity) / peak);
    }
  }
  const startEquity = equityCurve[0].equity;
  const endEquity = equityCurve[equityCurve.length - 1].equity;
  return {
    startEquity,
    endEquity,
    totalReturnPct: startEquity > 0 ? (endEquity - startEquity) / startEquity : 0,
    maxDrawdownPct,
    stepCount: equityCurve.length
  };
};

const withReplayEnv = async <T>(outputDir: string, fn: () => Promise<T>): Promise<T> => {
  const priorEnv = {
    LEDGER_FILE: process.env.LEDGER_FILE,
    DISLOCATION_STATE_PATH: process.env.DISLOCATION_STATE_PATH,
    DISLOCATION_SLEEVE_STATE_PATH: process.env.DISLOCATION_SLEEVE_STATE_PATH,
    SLEEVE_POSITIONS_PATH: process.env.SLEEVE_POSITIONS_PATH,
    INSURANCE_STATE_PATH: process.env.INSURANCE_STATE_PATH,
    GROWTH_STATE_PATH: process.env.GROWTH_STATE_PATH,
    FRED_API_KEY: process.env.FRED_API_KEY,
    FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
    USE_REAL_LLM: process.env.USE_REAL_LLM,
    REPLAY_CLOCK_ISO: process.env.REPLAY_CLOCK_ISO
  };
  process.env.LEDGER_FILE = path.join(outputDir, 'ledger', 'events.jsonl');
  process.env.DISLOCATION_STATE_PATH = path.join(outputDir, 'state', 'dislocation_state.json');
  process.env.DISLOCATION_SLEEVE_STATE_PATH = path.join(outputDir, 'state', 'dislocation_sleeve_state.json');
  process.env.SLEEVE_POSITIONS_PATH = path.join(outputDir, 'state', 'sleeve_positions.json');
  process.env.INSURANCE_STATE_PATH = path.join(outputDir, 'state', 'insurance_state.json');
  process.env.GROWTH_STATE_PATH = path.join(outputDir, 'state', 'growth_state.json');
  process.env.FRED_API_KEY = '';
  process.env.FINNHUB_API_KEY = '';
  process.env.USE_REAL_LLM = 'false';
  try {
    return await fn();
  } finally {
    process.env.LEDGER_FILE = priorEnv.LEDGER_FILE;
    process.env.DISLOCATION_STATE_PATH = priorEnv.DISLOCATION_STATE_PATH;
    process.env.DISLOCATION_SLEEVE_STATE_PATH = priorEnv.DISLOCATION_SLEEVE_STATE_PATH;
    process.env.SLEEVE_POSITIONS_PATH = priorEnv.SLEEVE_POSITIONS_PATH;
    process.env.INSURANCE_STATE_PATH = priorEnv.INSURANCE_STATE_PATH;
    process.env.GROWTH_STATE_PATH = priorEnv.GROWTH_STATE_PATH;
    process.env.FRED_API_KEY = priorEnv.FRED_API_KEY;
    process.env.FINNHUB_API_KEY = priorEnv.FINNHUB_API_KEY;
    process.env.USE_REAL_LLM = priorEnv.USE_REAL_LLM;
    process.env.REPLAY_CLOCK_ISO = priorEnv.REPLAY_CLOCK_ISO;
  }
};

interface ReplayReserveAccounting {
  capitalLanes: ReplayStepSummary['capitalLanes'];
  executedOptionReserveUsageUsd: number;
  executedDislocationCoreUsageUsd: number;
  executedReserveUsageUsd: number;
  plannedOptionReserveStateUsd: number;
  plannedOptionReserveStateBySleeve: {
    insurancePremiumStateUsd: number;
    growthPremiumStateUsd: number;
  };
}

interface OptionExecutionPlan {
  plannedAction?: 'OPEN' | 'CLOSE' | 'HOLD' | 'NONE' | 'ROLL';
  state?: {
    underlying?: string;
    strike?: number;
    expiry?: string;
    contracts?: number;
    premiumUSD?: number;
    activeEpisodeId?: string;
    stagedEntryCount?: number;
    consecutiveStressSteps?: number;
    consecutiveNormalizationSteps?: number;
    lastEntryAsOf?: string;
  };
  order?: {
    optionSymbol?: string;
    strike?: number;
    expiry?: string;
    quantity?: number;
    limitPrice?: number;
  };
  rollOrder?: {
    optionSymbol?: string;
    strike?: number;
    expiry?: string;
    quantity?: number;
    limitPrice?: number;
  };
}

const optionCostBasisUsd = (position: OptionPosition) =>
  Math.max(0, position.costBasisUsd ?? (position.avgOpenPrice || 0) * (position.contracts || 0) * (position.multiplier || 100));

const resolveOptionOpenInput = (
  plan: OptionExecutionPlan,
  maxSpendUsd: number
):
  | {
      underlying: string;
      strike: number;
      expiry?: string | null;
      contracts: number;
      premiumPerShare: number;
    }
  | null => {
  if (plan.plannedAction !== 'OPEN') return null;
  const underlying = plan.order?.optionSymbol || plan.state?.underlying;
  const strike = plan.order?.strike ?? plan.state?.strike;
  const requestedContracts = Math.floor(plan.order?.quantity ?? plan.state?.contracts ?? 0);
  const premiumPerShare =
    plan.order?.limitPrice ??
    ((plan.state?.premiumUSD || 0) > 0 && requestedContracts > 0 ? (plan.state?.premiumUSD || 0) / (requestedContracts * 100) : 0);
  if (!underlying || !strike || requestedContracts < 1 || premiumPerShare <= 0) return null;
  const affordableContracts = Math.floor(Math.max(0, maxSpendUsd) / (premiumPerShare * 100));
  const contracts = Math.min(requestedContracts, affordableContracts);
  if (contracts < 1) return null;
  return {
    underlying,
    strike,
    expiry: plan.order?.expiry || plan.state?.expiry || null,
    contracts,
    premiumPerShare
  };
};

const syncReplayInsuranceState = (runId: string, asOf: string, portfolio: PortfolioState) => {
  const priorState = loadInsuranceState();
  const insurancePositions = (portfolio.optionPositions || []).filter(
    (position) => position.type === 'PUT' && (position.contracts || 0) > 0
  );
  if (!insurancePositions.length) {
    saveInsuranceState({
      ...priorState,
      status: 'INACTIVE',
      underlying: undefined,
      strike: undefined,
      expiry: undefined,
      contracts: undefined,
      premiumUSD: undefined
    });
    return;
  }
  const sortedByExpiry = [...insurancePositions].sort((a, b) => {
    const expiryCompare = String(a.expiry || '').localeCompare(String(b.expiry || ''));
    if (expiryCompare !== 0) return expiryCompare;
    return String(a.openDate || '').localeCompare(String(b.openDate || ''));
  });
  const anchorPosition = sortedByExpiry[0];
  saveInsuranceState({
    ...priorState,
    status: 'DEPLOYED',
    openedRunId: runId,
    openedAsOf:
      sortedByExpiry.reduce<string | undefined>((earliest, position) => {
        if (!position.openDate) return earliest;
        if (!earliest || position.openDate < earliest) return position.openDate;
        return earliest;
      }, priorState.openedAsOf || asOf) || asOf,
    underlying: anchorPosition.underlying || priorState.underlying,
    strike: anchorPosition.strike,
    expiry: anchorPosition.expiry,
    contracts: insurancePositions.reduce((sum, position) => sum + (position.contracts || 0), 0),
    premiumUSD: insurancePositions.reduce((sum, position) => sum + optionCostBasisUsd(position), 0),
    stagedEntryCount: Math.max(priorState.stagedEntryCount || 0, insurancePositions.length),
    lastEntryAsOf:
      insurancePositions.reduce<string | undefined>((latest, position) => {
        if (!position.openDate) return latest;
        if (!latest || position.openDate > latest) return position.openDate;
        return latest;
      }, priorState.lastEntryAsOf) || priorState.lastEntryAsOf
  });
};

const syncReplayGrowthState = (runId: string, asOf: string, portfolio: PortfolioState) => {
  const priorState = loadGrowthState();
  const growthPositions = (portfolio.optionPositions || []).filter(
    (position) => position.type === 'CALL' && (position.contracts || 0) > 0
  );
  if (!growthPositions.length) {
    saveGrowthState({
      ...priorState,
      status: 'INACTIVE',
      underlying: undefined,
      strike: undefined,
      expiry: undefined,
      contracts: undefined,
      premiumUSD: undefined
    });
    return;
  }
  const sortedByExpiry = [...growthPositions].sort((a, b) => {
    const expiryCompare = String(a.expiry || '').localeCompare(String(b.expiry || ''));
    if (expiryCompare !== 0) return expiryCompare;
    return String(a.openDate || '').localeCompare(String(b.openDate || ''));
  });
  const anchorPosition = sortedByExpiry[0];
  saveGrowthState({
    ...priorState,
    status: 'DEPLOYED',
    openedRunId: runId,
    openedAsOf:
      sortedByExpiry.reduce<string | undefined>((earliest, position) => {
        if (!position.openDate) return earliest;
        if (!earliest || position.openDate < earliest) return position.openDate;
        return earliest;
      }, priorState.openedAsOf || asOf) || asOf,
    underlying: anchorPosition.underlying || priorState.underlying,
    strike: anchorPosition.strike,
    expiry: anchorPosition.expiry,
    contracts: growthPositions.reduce((sum, position) => sum + (position.contracts || 0), 0),
    premiumUSD: growthPositions.reduce((sum, position) => sum + optionCostBasisUsd(position), 0)
  });
};

const computeReserveAccounting = async (
  outputDir: string,
  provider: HistoricalMarketDataProvider,
  asOf: string,
  portfolio: PortfolioState,
  config: BotConfig
): Promise<ReplayReserveAccounting> => {
  const sleevePositions = readJson<Record<string, { dislocationQty?: number }>>(
    path.join(outputDir, 'state', 'sleeve_positions.json'),
    {}
  );
  const insuranceState = readJson<{ status?: string; premiumUSD?: number }>(
    path.join(outputDir, 'state', 'insurance_state.json'),
    {}
  );
  const growthState = readJson<{ status?: string; premiumUSD?: number }>(
    path.join(outputDir, 'state', 'growth_state.json'),
    {}
  );

  let deployedDislocationUsd = 0;
  for (const [symbol, position] of Object.entries(sleevePositions)) {
    const dislocationQty = position?.dislocationQty || 0;
    if (dislocationQty <= 0) continue;
    const quote = await provider.getQuote(symbol, asOf);
    deployedDislocationUsd += dislocationQty * quote.price;
  }

  const executedOptionReserveUsageUsd = computeOptionReserveUsageUsd(portfolio.optionPositions || []);
  const hasExecutedInsurancePosition = (portfolio.optionPositions || []).some(
    (position) => position.type === 'PUT' && (position.contracts || 0) > 0
  );
  const hasExecutedGrowthPosition = (portfolio.optionPositions || []).some(
    (position) => position.type === 'CALL' && (position.contracts || 0) > 0
  );
  const navUsd = portfolio.equity || 0;
  const etfInvestedUsd = Math.max(0, navUsd - (portfolio.cash || 0) - (portfolio.optionsMarketValueUsd || 0));
  const capitalLanes = computeCapitalLanes({
    navUsd,
    etfInvestedUsd,
    cashUsd: portfolio.cash || 0,
    executedOptionReserveUsageUsd,
    config
  });

  const insurancePremiumStateUsd =
    !hasExecutedInsurancePosition && insuranceState?.status && insuranceState.status !== 'INACTIVE'
      ? Math.max(0, insuranceState.premiumUSD || 0)
      : 0;
  const growthPremiumStateUsd =
    !hasExecutedGrowthPosition && growthState?.status && growthState.status !== 'INACTIVE'
      ? Math.max(0, growthState.premiumUSD || 0)
      : 0;

  return {
    capitalLanes: {
      coreCapitalUsd: capitalLanes.coreCapitalUsd,
      coreCashUsd: capitalLanes.coreCashUsd,
      coreHeadroomUsd: capitalLanes.coreHeadroomUsd,
      executedDislocationCoreUsageUsd: deployedDislocationUsd,
      optionsReserveCapitalUsd: capitalLanes.optionsReserveCapitalUsd,
      optionsReserveCashUsd: capitalLanes.optionsReserveCashUsd,
      optionsReserveHeadroomUsd: capitalLanes.optionsReserveHeadroomUsd
    },
    executedOptionReserveUsageUsd,
    executedDislocationCoreUsageUsd: deployedDislocationUsd,
    executedReserveUsageUsd: executedOptionReserveUsageUsd,
    plannedOptionReserveStateUsd: insurancePremiumStateUsd + growthPremiumStateUsd,
    plannedOptionReserveStateBySleeve: {
      insurancePremiumStateUsd,
      growthPremiumStateUsd
    }
  };
};

export const runHistoricalReplay = async (options: HistoricalReplayOptions): Promise<HistoricalReplayResult> => {
  const configPath = options.configPath
    ? path.resolve(process.cwd(), options.configPath)
    : path.resolve(process.cwd(), 'src/config/default.json');
  const config = loadConfig(configPath) as BotConfig;
  const input = options.input;
  const outputDir =
    options.outputDir || path.resolve(process.cwd(), 'runs', `replay-${Date.now().toString(36)}`);
  ensureDir(outputDir);

  const universe = input.universe?.length ? input.universe : Object.keys(input.series);
  const provider = new HistoricalMarketDataProvider(input.series);
  const broker = new ReplayBroker(config, provider, resolveStartingPortfolio(input, config));
  const { executionDates, recordedDates } = buildReplayDates(provider, input, universe);
  const runPrefix = safeName(options.runPrefix || path.basename(outputDir));
  const asOfTime = input.asOfTime || 'T16:00';
  const stepSummaries: ReplayStepSummary[] = [];
  const stepRunIds: string[] = [];
  let priorRegimes: any;
  let priorRegimeState: { label?: string; timeInRegimeWeeks?: number } | undefined;
  let priorReRiskCorridorState: any;
  let priorExposureStateControllerState: any;

  await withReplayEnv(outputDir, async () => {
    for (const date of executionDates) {
      const asOf = `${date}${asOfTime}`;
      process.env.REPLAY_CLOCK_ISO = asOf;
      const runId = `${runPrefix}-${date}`;
      const runDir = path.resolve(process.cwd(), 'runs', runId);
      broker.startReplayStep();
      const optionCashEvents: OptionCashEvent[] = await broker.expireOptionPositions(asOf);
      if (optionCashEvents.some((event) => event.type === 'OPT_EXPIRE' && event.sleeve === 'insurance')) {
        saveInsuranceState({ status: 'INACTIVE' });
      }
      if (optionCashEvents.some((event) => event.type === 'OPT_EXPIRE' && event.sleeve === 'growth')) {
        saveGrowthState({ status: 'INACTIVE' });
      }
      await runBot({
        asof: asOf,
        runId,
        mode: 'backtest',
        strategy: options.strategy || 'deterministic',
        force: true,
        autoExec: true,
        dryRun: false,
        configOverride: config,
        universeOverride: universe,
        marketDataOverride: provider,
        brokerOverride: broker,
        priorRegimes,
        priorRegimeState,
        priorReRiskCorridorState,
        priorExposureStateControllerState,
        contextOptions: {
          lookbackDays: input.lookbackDays ?? 250,
          macroSeries: filterMacroSeries(input.macroSeries, date)
        },
        skipReports: true
      });

      const regimes = readJson<any>(path.join(runDir, 'regimes.json'), {});
      const capitalDeployment = readJson<any>(path.join(runDir, 'capital_deployment.json'), {});
      const insurancePlan = readJson<OptionExecutionPlan>(path.join(runDir, 'insurance_plan.json'), { plannedAction: 'NONE' });
      const growthPlan = readJson<OptionExecutionPlan>(path.join(runDir, 'growth_plan.json'), { plannedAction: 'NONE' });
      const capitalBudgets = readJson<{
        capitalLanes?: {
          coreCapitalUsd?: number;
          coreCashUsd?: number;
          coreHeadroomUsd?: number;
          optionsReserveCapitalUsd?: number;
          optionsReserveCashUsd?: number;
          optionsReserveHeadroomUsd?: number;
          executedOptionReserveUsageUsd?: number;
        };
      }>(path.join(runDir, 'capital_budgets.json'), {});
      const preOptionPortfolio = await broker.getPortfolioState(asOf);
      const reserveAccountingBeforeOption = await computeReserveAccounting(outputDir, provider, asOf, preOptionPortfolio, config);
      const availableInsuranceReserveUsd = Math.max(
        0,
        capitalBudgets?.capitalLanes?.optionsReserveCashUsd ?? reserveAccountingBeforeOption.capitalLanes.optionsReserveCashUsd
      );
      const rollAvailableInsuranceReserveUsd = Math.max(
        0,
        Math.min(
          availableInsuranceReserveUsd + (preOptionPortfolio.optionsMarketValueUsd || 0),
          reserveAccountingBeforeOption.capitalLanes.optionsReserveCapitalUsd
        )
      );

      if (insurancePlan.plannedAction === 'CLOSE') {
        await broker.closeInsuranceOption(asOf, 'insurance_planner_close');
      } else if (insurancePlan.plannedAction === 'ROLL') {
        await broker.closeInsuranceOption(asOf, 'insurance_roll_close');
        const openInput = resolveOptionOpenInput(
          {
            ...insurancePlan,
            plannedAction: 'OPEN',
            order: insurancePlan.rollOrder || insurancePlan.order
          },
          rollAvailableInsuranceReserveUsd
        );
        if (openInput) {
          await broker.openInsuranceOption(openInput, asOf);
        }
      } else if (insurancePlan.plannedAction === 'OPEN') {
        const openInput = resolveOptionOpenInput(insurancePlan, availableInsuranceReserveUsd);
        if (openInput) {
          await broker.openInsuranceOption(openInput, asOf);
        } else {
          saveInsuranceState({ status: 'INACTIVE' });
        }
      }

      const afterInsurancePortfolio = await broker.getPortfolioState(asOf);
      const reserveAccountingBeforeGrowth = await computeReserveAccounting(
        outputDir,
        provider,
        asOf,
        afterInsurancePortfolio,
        config
      );
      const availableGrowthReserveUsd = Math.max(
        0,
        reserveAccountingBeforeGrowth.capitalLanes.optionsReserveCashUsd
      );
      const rollAvailableGrowthReserveUsd = Math.max(
        0,
        Math.min(
          availableGrowthReserveUsd + (afterInsurancePortfolio.optionsMarketValueUsd || 0),
          reserveAccountingBeforeGrowth.capitalLanes.optionsReserveCapitalUsd
        )
      );

      if (growthPlan.plannedAction === 'CLOSE') {
        await broker.closeGrowthOption(asOf, 'growth_planner_close');
      } else if (growthPlan.plannedAction === 'ROLL') {
        await broker.closeGrowthOption(asOf, 'growth_roll_close');
        const openInput = resolveOptionOpenInput(
          {
            ...growthPlan,
            plannedAction: 'OPEN',
            order: growthPlan.rollOrder || growthPlan.order
          },
          rollAvailableGrowthReserveUsd
        );
        if (openInput) {
          await broker.openGrowthOption(openInput, asOf);
        }
      } else if (growthPlan.plannedAction === 'OPEN') {
        const openInput = resolveOptionOpenInput(growthPlan, availableGrowthReserveUsd);
        if (openInput) {
          await broker.openGrowthOption(openInput, asOf);
        } else {
          saveGrowthState({ status: 'INACTIVE' });
        }
      }

      optionCashEvents.push(...broker.drainOptionCashEvents());
      const holdingsAfterExecution = await broker.getPortfolioState(asOf);
      syncReplayInsuranceState(runId, asOf, holdingsAfterExecution);
      syncReplayGrowthState(runId, asOf, holdingsAfterExecution);

      if (!recordedDates.has(date)) {
        priorRegimes = regimes || priorRegimes;
        priorRegimeState = {
          label: priorRegimes?.equityRegime?.label,
          timeInRegimeWeeks:
            priorRegimes?.equityRegime?.supports?.timeInRegimeWeeks ??
            priorRegimes?.equityRegime?.timeInRegimeWeeks ??
            priorRegimeState?.timeInRegimeWeeks
        };
        priorReRiskCorridorState = capitalDeployment?.reRiskCorridor?.state ?? priorReRiskCorridorState;
        priorExposureStateControllerState =
          capitalDeployment?.exposureState?.state ?? priorExposureStateControllerState;
        continue;
      }

      stepRunIds.push(runId);

      const executionPlan = readJson<any>(path.join(runDir, 'execution_plan.json'), {
        targetWeights: {},
        achievedWeights: {}
      });
      const orders = readJson<TradeOrder[]>(path.join(runDir, 'orders.json'), []);
      const dislocationState = readJson<any>(path.join(runDir, 'dislocation_state.json'), {});
      const round5Flags = readJson<any[]>(path.join(runDir, 'round5_flags.json'), []);
      const dislocationFlags = readJson<any[]>(path.join(runDir, 'dislocation_flags.json'), []);
      const dataAdequacy = readJson<{ adequate?: boolean }>(path.join(runDir, 'dataAdequacy.json'), { adequate: true });
      const sleeveTriggerEvents = [...dislocationFlags, ...round5Flags]
        .filter((flag) => typeof flag?.code === 'string' && (flag.code.includes('DISLOCATION') || flag.code.includes('POST_RISK_OFF')))
        .map((flag) => ({ code: flag.code, message: flag.message || flag.code, observed: flag.observed }));
      const reserveAccounting = await computeReserveAccounting(outputDir, provider, asOf, holdingsAfterExecution, config);

      const summary: ReplayStepSummary = {
        date,
        asOf,
        runId,
        runStatus: dataAdequacy.adequate === false ? 'warmup' : 'completed',
        regime: regimes?.equityRegime?.label ?? null,
        confidence: regimes?.equityRegime?.confidence ?? null,
        exposureCap: capitalDeployment?.exposureCap ?? null,
        deployBudgetUsd: capitalDeployment?.deployBudgetUsd ?? null,
        targetAllocations: executionPlan?.targetWeights || {},
        achievedAllocations: executionPlan?.achievedWeights || {},
        orders,
        holdingsAfterExecution,
        optionCashEvents,
        capitalLanes: reserveAccounting.capitalLanes,
        executedOptionReserveUsageUsd: reserveAccounting.executedOptionReserveUsageUsd,
        executedReserveUsageUsd: reserveAccounting.executedReserveUsageUsd,
        reserveUsageUsd: reserveAccounting.executedReserveUsageUsd,
        plannedOptionReserveStateUsd: reserveAccounting.plannedOptionReserveStateUsd,
        plannedOptionReserveStateBySleeve: reserveAccounting.plannedOptionReserveStateBySleeve,
        sleeveTriggerEvents,
        dislocationState,
        artifactDir: runDir
      };
      stepSummaries.push(summary);
      writeJSONFile(path.join(outputDir, 'steps', `${date}.json`), summary);

      priorRegimes = regimes;
      priorRegimeState = {
        label: regimes?.equityRegime?.label,
        timeInRegimeWeeks:
          regimes?.equityRegime?.supports?.timeInRegimeWeeks ?? regimes?.equityRegime?.timeInRegimeWeeks ?? undefined
      };
      priorReRiskCorridorState = capitalDeployment?.reRiskCorridor?.state ?? priorReRiskCorridorState;
      priorExposureStateControllerState =
        capitalDeployment?.exposureState?.state ?? priorExposureStateControllerState;
    }
  });

  const equityCurve = stepSummaries.map((step) => ({
    date: step.date,
    equity: step.holdingsAfterExecution.equity,
    cash: step.holdingsAfterExecution.cash
  }));
  const holdingsHistory = stepSummaries.map((step) => ({
    date: step.date,
    holdings: step.holdingsAfterExecution.holdings,
    cash: step.holdingsAfterExecution.cash,
    equity: step.holdingsAfterExecution.equity
  }));
  const optionPositionsHistory = stepSummaries.map((step) => ({
    date: step.date,
    optionPositions: step.holdingsAfterExecution.optionPositions || [],
    optionsMarketValueUsd: step.holdingsAfterExecution.optionsMarketValueUsd || 0
  }));
  const orderLog = stepSummaries.flatMap((step) => step.orders.map((order) => ({ date: step.date, runId: step.runId, order })));
  const optionCashEventLog = stepSummaries.flatMap((step) => step.optionCashEvents);
  const sleeveEventLog = stepSummaries.flatMap((step) =>
    step.sleeveTriggerEvents.map((event) => ({ date: step.date, runId: step.runId, ...event }))
  );
  const summaryStats = computeSummaryStats(equityCurve);
  const strategyPerformance = computeReplayPerformanceStats(equityCurve, input.barFrequency);
  const strategyEquityCurveCsv = path.join(outputDir, 'strategy_equity_curve.csv');
  writeCsv(
    strategyEquityCurveCsv,
    ['date', 'equity', 'cash'],
    equityCurve.map((point) => [point.date, point.equity.toFixed(6), point.cash.toFixed(6)])
  );

  const benchmarkResults = await runReplayBenchmarks({
    provider,
    dates: stepSummaries.map((step) => step.date),
    startingEquity: summaryStats.startEquity,
    outputDir,
    barFrequency: input.barFrequency,
    asOfTime
  });
  const performanceComparison = [
    {
      label: 'Current Strategy',
      type: 'strategy' as const,
      startEquity: strategyPerformance.startEquity,
      endEquity: strategyPerformance.endEquity,
      totalReturnPct: strategyPerformance.totalReturnPct,
      maxDrawdownPct: strategyPerformance.maxDrawdownPct,
      annualizedVolatilityPct: strategyPerformance.annualizedVolatilityPct,
      annualizedReturnPct: strategyPerformance.annualizedReturnPct,
      peakDateBeforeMaxDrawdown: strategyPerformance.peakDateBeforeMaxDrawdown,
      troughDate: strategyPerformance.troughDate ?? undefined,
      recoveryDate: strategyPerformance.recoveryDate,
      recoveryBars: strategyPerformance.recoveryBars
    },
    ...benchmarkResults.map((benchmark) => ({
      label: benchmark.label,
      type: 'benchmark' as const,
      startEquity: benchmark.summaryStats.startEquity,
      endEquity: benchmark.summaryStats.endEquity,
      totalReturnPct: benchmark.summaryStats.totalReturnPct,
      maxDrawdownPct: benchmark.summaryStats.maxDrawdownPct,
      annualizedVolatilityPct: benchmark.summaryStats.annualizedVolatilityPct,
      annualizedReturnPct: benchmark.summaryStats.annualizedReturnPct,
      peakDateBeforeMaxDrawdown: benchmark.summaryStats.peakDateBeforeMaxDrawdown,
      troughDate: benchmark.summaryStats.troughDate ?? undefined,
      recoveryDate: benchmark.summaryStats.recoveryDate,
      recoveryBars: benchmark.summaryStats.recoveryBars
    }))
  ];

  const validationArtifacts = buildValidationArtifacts({
    input,
    outputDir,
    runPrefix,
    steps: stepSummaries,
    strategyEquityCurve: equityCurve,
    strategyPerformance,
    strategyOrderLog: orderLog,
    sleeveEventLog,
    benchmarkResults
  });
  const portfolioRowByLabel = new Map(
    validationArtifacts.portfolioSummaryRows.map((row) => [
      row.type === 'strategy' ? 'Current Strategy' : row.portfolio,
      row
    ])
  );
  const performanceComparisonWithTurnover = performanceComparison.map((row) => {
    const validationRow = portfolioRowByLabel.get(row.label);
    return {
      ...row,
      turnoverPct: validationRow?.turnoverPct
    };
  });

  const result: HistoricalReplayResult = {
    outputDir,
    runPrefix,
    stepRunIds,
    steps: stepSummaries,
    equityCurve,
    holdingsHistory,
    optionPositionsHistory,
    orderLog,
    optionCashEventLog,
    sleeveEventLog,
    benchmarkResults,
    performanceComparison: performanceComparisonWithTurnover,
    validationSummary: validationArtifacts.validationSummary,
    portfolioSummaryRows: validationArtifacts.portfolioSummaryRows,
    strategyDiagnostics: validationArtifacts.strategyDiagnostics,
    summaryStats
  };

  writeJSONFile(path.join(outputDir, 'replay_result.json'), result);
  writeJSONFile(path.join(outputDir, 'equity_curve.json'), equityCurve);
  writeJSONFile(path.join(outputDir, 'holdings_history.json'), holdingsHistory);
  writeJSONFile(path.join(outputDir, 'option_positions_history.json'), optionPositionsHistory);
  writeJSONFile(path.join(outputDir, 'order_log.json'), orderLog);
  writeJSONFile(path.join(outputDir, 'option_cash_event_log.json'), optionCashEventLog);
  writeJSONFile(path.join(outputDir, 'sleeve_event_log.json'), sleeveEventLog);
  writeJSONFile(path.join(outputDir, 'summary_stats.json'), summaryStats);
  writeJSONFile(path.join(outputDir, 'benchmark_results.json'), benchmarkResults);
  writeJSONFile(path.join(outputDir, 'performance_comparison.json'), performanceComparisonWithTurnover);
  writeValidationArtifacts({
    outputDir,
    validationSummary: validationArtifacts.validationSummary,
    portfolioSummaryRows: validationArtifacts.portfolioSummaryRows,
    strategyDiagnostics: validationArtifacts.strategyDiagnostics
  });
  writeCsv(
    path.join(outputDir, 'performance_comparison.csv'),
    [
      'label',
      'type',
      'startEquity',
      'endEquity',
      'totalReturnPct',
      'annualizedReturnPct',
      'maxDrawdownPct',
      'annualizedVolatilityPct',
      'turnoverPct',
      'peakDateBeforeMaxDrawdown',
      'troughDate',
      'recoveryDate',
      'recoveryBars'
    ],
    performanceComparisonWithTurnover.map((row) => [
      row.label,
      row.type,
      row.startEquity.toFixed(6),
      row.endEquity.toFixed(6),
      row.totalReturnPct.toFixed(8),
      row.annualizedReturnPct === undefined ? '' : row.annualizedReturnPct.toFixed(8),
      row.maxDrawdownPct.toFixed(8),
      row.annualizedVolatilityPct === null ? '' : row.annualizedVolatilityPct.toFixed(8),
      row.turnoverPct === undefined ? '' : row.turnoverPct.toFixed(8),
      row.peakDateBeforeMaxDrawdown || '',
      row.troughDate || '',
      row.recoveryDate || '',
      row.recoveryBars === null ? '' : String(row.recoveryBars)
    ])
  );

  return result;
};
