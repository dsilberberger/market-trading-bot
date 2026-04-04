import fs from 'fs';
import os from 'os';
import path from 'path';
import { runHistoricalReplay, HistoricalReplayInput, HistoricalReplayResult } from '../src/replay/runHistoricalReplay';
import {
  buildIncrementalDeltaV2PlannerInputs,
  computeMinimumExecutableDeltaUsd,
  selectEtfExecutionOrders
} from '../src/cli/run';
import { planBaseEtfExecution } from '../src/execution/wholeSharePlanner';

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

const writeReplayConfig = (name: string, mutate?: (config: any) => void) => {
  const dir = makeOutputDir(name);
  const configPath = path.join(dir, 'config.json');
  const config = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/config/default.small.json'), 'utf-8'));
  config.useLLM = false;
  config.requireApproval = false;
  config.allowExecutionProxies = false;
  config.canonicalizeExposureGroups = false;
  config.dislocation.enabled = false;
  config.dataAdequacy = {
    ...(config.dataAdequacy || {}),
    minHistorySamples: 8,
    minUniqueCloses: 4
  };
  config.reRiskCorridor = {
    mode: 'stateful_risk_on_corridor_v2',
    handoffContract: 'incremental_exposure_delta_v1',
    entryEquityAllocationThresholdPct: 0.4,
    weeklyAdvancePct: 0.05,
    maxCorridorTargetPct: 0.6,
    progressThresholdPct: 0.01,
    maxStallWeeks: 1
  };
  config.regimeClassification = {
    ...(config.regimeClassification || {}),
    equity: {
      mode: 'recovery_friendly',
      riskOnMinAgreementScore: 0,
      riskOnMinStabilityScore: 0,
      allowHighVolRiskOnOverride: true,
      highVolRiskOnMinAgreementScore: 0,
      highVolRiskOnMinStabilityScore: 0,
      highVolRiskOnMinRet12w: -1,
      highVolRiskOnMinRet24w: -1,
      highVolRiskOnMinConfidence: 0
    }
  };
  if (mutate) mutate(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
};

const buildInput = (
  anchorReturns: number[],
  startIndex: number,
  endIndex: number,
  options: {
    startingCash?: number;
    startingNav?: number;
    startingEquityAllocationPct?: number;
    rebalanceSymbol?: string;
  } = {}
): HistoricalReplayInput => {
  const { dates, series } = buildSeries(anchorReturns);
  const startingCash = options.startingCash ?? options.startingNav ?? 500;
  const startingNav = options.startingNav ?? startingCash;
  const startingEquityAllocationPct = options.startingEquityAllocationPct ?? 0;
  const rebalanceSymbol = options.rebalanceSymbol ?? 'VTI';
  const startPrice = series[rebalanceSymbol]?.[startIndex]?.close ?? 0;
  const targetEquityUsd = startingNav * startingEquityAllocationPct;
  const startingPortfolio =
    targetEquityUsd > 0 && startPrice > 0
      ? {
          cash: startingNav - targetEquityUsd,
          equity: startingNav,
          holdings: [
            {
              symbol: rebalanceSymbol,
              quantity: targetEquityUsd / startPrice,
              avgPrice: startPrice
            }
          ]
        }
      : undefined;
  return {
    series,
    universe: UNIVERSE,
    calendarSymbol: 'VTI',
    barFrequency: '1w',
    dateRange: {
      start: dates[startIndex],
      end: dates[endIndex]
    },
    startingCash,
    startingPortfolio
  };
};

const collectRunDirs = (result: HistoricalReplayResult) => {
  result.steps.forEach((step) => runDirs.add(step.artifactDir));
};

const collectExposureArtifacts = (result: HistoricalReplayResult) =>
  result.steps.map((step) => ({
    step,
    exposure: JSON.parse(fs.readFileSync(path.join(step.artifactDir, 'exposure_state.json'), 'utf-8')),
    risk: JSON.parse(fs.readFileSync(path.join(step.artifactDir, 'risk_report.json'), 'utf-8'))
  }));

describe('incremental exposure delta handoff', () => {
  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    for (const dir of runDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('routes active controller execution through controller-delta buys instead of rebalance sells', () => {
    const orders = selectEtfExecutionOrders({
      controllerDeltaPathActive: true,
      controllerDeltaOrders: [
        {
          symbol: 'VXUS',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 80,
          thesis: 'delta buy',
          invalidation: '',
          confidence: 0.6,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 },
          executionPath: 'controller_delta'
        }
      ],
      rebalanceOrders: [
        {
          symbol: 'VTI',
          side: 'SELL',
          orderType: 'MARKET',
          notionalUSD: 100,
          thesis: 'rebalance sell',
          invalidation: '',
          confidence: 0.6,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 },
          executionPath: 'rebalance'
        }
      ],
      dislocationOrders: [
        {
          symbol: 'VTV',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 40,
          thesis: 'overlay',
          invalidation: '',
          confidence: 0.6,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 },
          executionPath: 'dislocation'
        }
      ]
    });

    expect(orders.map((order) => order.side)).toEqual(['BUY', 'BUY']);
    expect(orders.some((order) => order.executionPath === 'rebalance')).toBe(false);
  });

  it('keeps positive requested controller deltas additive in replay artifacts', async () => {
    const configPath = writeReplayConfig('incremental-delta-additive');
    const input = buildInput(Array(52).fill(0.05), 26, 44, {
      startingNav: 100,
      startingCash: 61,
      startingEquityAllocationPct: 0.39
    });
    const outputDir = makeOutputDir('incremental-delta-additive-output');

    const result = await runHistoricalReplay({
      input,
      configPath,
      outputDir,
      runPrefix: `replay-incremental-delta-additive-${Date.now()}`,
      strategy: 'deterministic'
    });
    collectRunDirs(result);

    const artifacts = collectExposureArtifacts(result).filter(
      ({ exposure }) => Number(exposure?.controllerOutputs?.requestedExposureDeltaUsd || 0) > 0
    );

    expect(artifacts.length).toBeGreaterThan(0);
    for (const { exposure, risk } of artifacts) {
      expect(exposure.contractType).toBe('incremental_exposure_delta_v1');
      expect(exposure.controllerDeltaSellOrdersCount).toBe(0);
      expect(exposure.negativeRealizedDeltaOnPositiveRequest).toBe(false);
      expect(
        (risk.approvedOrders || []).filter(
          (order: any) => order.executionPath === 'controller_delta' && order.side === 'SELL'
      ).length
    ).toBe(0);
  }
  });

  it('chooses the cheapest executable symbol in v2 delta mode instead of splitting a tight budget', () => {
    const orders = [
      {
        symbol: 'VTI',
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: 60,
        thesis: '',
        invalidation: '',
        confidence: 0.9,
        portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
      },
      {
        symbol: 'VXUS',
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: 40,
        thesis: '',
        invalidation: '',
        confidence: 0.8,
        portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
      },
      {
        symbol: 'USMV',
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: 20,
        thesis: '',
        invalidation: '',
        confidence: 0.2,
        portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
      }
    ] as const;
    const prices = { VTI: 41.85, VXUS: 45.2, USMV: 18.43 };

    expect(computeMinimumExecutableDeltaUsd({ orders: [...orders], prices })).toBeCloseTo(18.43);

    const selection = buildIncrementalDeltaV2PlannerInputs({
      orders: [...orders],
      prices,
      buyBudgetUSD: 24.95
    });

    expect(selection.selectionMode).toBe('single_cheapest_symbol');
    expect(selection.cheapestExecutableSymbol).toBe('USMV');
    expect(selection.orders).toHaveLength(1);
    expect(selection.orders[0].symbol).toBe('USMV');
    expect(selection.orders[0].notionalUSD).toBeCloseTo(24.95);
  });

  it('produces a non-zero planner buy in v2 when the minimum executable jump is affordable', () => {
    const prices = { VTI: 41.85, VXUS: 45.2, USMV: 18.43 };
    const selection = buildIncrementalDeltaV2PlannerInputs({
      orders: [
        {
          symbol: 'VTI',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 60,
          thesis: '',
          invalidation: '',
          confidence: 0.9,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
        },
        {
          symbol: 'VXUS',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 40,
          thesis: '',
          invalidation: '',
          confidence: 0.8,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
        },
        {
          symbol: 'USMV',
          side: 'BUY',
          orderType: 'MARKET',
          notionalUSD: 20,
          thesis: '',
          invalidation: '',
          confidence: 0.2,
          portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
        }
      ],
      prices,
      buyBudgetUSD: 48
    });

    const planner = planBaseEtfExecution({
      targets: selection.orders.map((order) => ({
        symbol: order.symbol,
        notionalUSD: order.notionalUSD,
        priority: order.confidence
      })),
      prices,
      buyBudgetUSD: 48,
      minCashUSD: 0,
      allowPartial: true,
      minViablePositions: 1,
      maxAbsWeightError: 0.2,
      allowProxies: false,
      regimeLabel: 'risk_on',
      timeInRegimeWeeks: 2
    });

    expect(selection.selectionMode).toBe('single_cheapest_symbol');
    expect(planner.status).not.toBe('UNEXECUTABLE');
    expect(planner.orders.length).toBeGreaterThan(0);
    expect(planner.orders.some((order) => order.symbol === 'USMV' && order.estNotionalUSD > 0)).toBe(true);
  });

  it('is deterministic and degrades planner failures to zero-fill instead of liquidation', async () => {
    const configPath = writeReplayConfig('incremental-delta-deterministic', (config) => {
      config.fractionalSharesSupported = false;
      config.rebalance = {
        ...(config.rebalance || {}),
        minTradeNotionalUSD: 25
      };
    });
    const input = buildInput(Array(52).fill(0.05), 26, 44, {
      startingNav: 100,
      startingCash: 61,
      startingEquityAllocationPct: 0.39
    });
    const runPrefix = `replay-incremental-delta-deterministic-${Date.now()}`;

    const first = await runHistoricalReplay({
      input,
      configPath,
      outputDir: makeOutputDir('incremental-delta-deterministic-first'),
      runPrefix: `${runPrefix}-first`,
      strategy: 'deterministic'
    });
    const second = await runHistoricalReplay({
      input,
      configPath,
      outputDir: makeOutputDir('incremental-delta-deterministic-second'),
      runPrefix: `${runPrefix}-second`,
      strategy: 'deterministic'
    });
    collectRunDirs(first);
    collectRunDirs(second);

    const normalize = (result: HistoricalReplayResult) =>
      collectExposureArtifacts(result).map(({ step, exposure }) => ({
        date: step.date,
        contractType: exposure.contractType,
        requestedExposureDeltaUsd: exposure.controllerOutputs?.requestedExposureDeltaUsd || 0,
        deltaBuyBudgetUsd: exposure.controllerOutputs?.deltaBuyBudgetUsd || 0,
        plannedDeltaBuyUsd: exposure.implementationPlan?.plannedDeltaBuyUsd || 0,
        approvedDeltaBuyUsd: exposure.riskOutcome?.approvedDeltaBuyUsd || 0,
        realizedExposureDeltaUsd: exposure.realizedOutcome?.realizedExposureDeltaUsd || 0,
        implementationStallReason: exposure.implementationStallReason || null
      }));

    expect(normalize(first)).toEqual(normalize(second));

    for (const { exposure } of collectExposureArtifacts(first)) {
      expect(exposure.controllerDeltaSellOrdersCount).toBe(0);
      if (Number(exposure.controllerOutputs?.requestedExposureDeltaUsd || 0) > 0) {
        expect(Number(exposure.realizedOutcome?.realizedExposureDeltaUsd || 0)).toBeGreaterThanOrEqual(0);
      }
    }
  }, 60000);
});
