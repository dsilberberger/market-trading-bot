import fs from 'fs';
import path from 'path';
import { runBot } from '../src/cli/run';

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf-8')) as T;

describe('live run artifacts invariants', () => {
  const asOf = '2025-01-07'; // Tuesday to satisfy default cadence
  let runId: string;
  let runDir: string;

  beforeAll(async () => {
    const prevBroker = process.env.BROKER_PROVIDER;
    const prevUseLive = process.env.USE_LIVE_DATA_IN_PAPER;
    const prevUsePortfolio = process.env.USE_ETRADE_PORTFOLIO_IN_PAPER;
    process.env.BROKER_PROVIDER = 'stub';
    process.env.USE_LIVE_DATA_IN_PAPER = 'false';
    process.env.USE_ETRADE_PORTFOLIO_IN_PAPER = 'false';
    runId = `test-live-artifacts-${Date.now()}`;
    runDir = path.resolve(process.cwd(), 'runs', runId);
    if (fs.existsSync(runDir)) fs.rmSync(runDir, { recursive: true, force: true });
    await runBot({
      asof: asOf,
      mode: 'paper',
      strategy: 'deterministic',
      dryRun: true,
      force: true,
      runId
    });
    process.env.BROKER_PROVIDER = prevBroker;
    process.env.USE_LIVE_DATA_IN_PAPER = prevUseLive;
    process.env.USE_ETRADE_PORTFOLIO_IN_PAPER = prevUsePortfolio;
  }, 30000);

  afterAll(() => {
    if (fs.existsSync(runDir)) fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('enforces 70/30 wall for ETF buys and option premium', () => {
    const capitalPools = readJson<{ corePoolUsd: number; reservePoolUsd: number }>(
      path.join(runDir, 'capitalPools.json')
    );
    const deploy = readJson<{ deployBudgetUsd: number }>(path.join(runDir, 'capital_deployment.json'));
    const etfOrders = readJson<{ orders: Array<{ side: string; notionalUsd: number }> }>(
      path.join(runDir, 'etfOrders.json')
    );
    const optionOrders = readJson<{ orders: Array<{ action: string; estimatedPremiumUsd: number }> }>(
      path.join(runDir, 'optionOrders.json')
    );
    const etfBuy = etfOrders.orders
      .filter((o) => o.side === 'BUY')
      .reduce((acc, o) => acc + (o.notionalUsd || 0), 0);
    const optionPremium = optionOrders.orders
      .filter((o) => o.action === 'OPEN')
      .reduce((acc, o) => acc + (o.estimatedPremiumUsd || 0), 0);

    expect(etfBuy).toBeLessThanOrEqual(capitalPools.corePoolUsd + 1e-6);
    expect(etfBuy).toBeLessThanOrEqual(deploy.deployBudgetUsd + 1e-6);
    expect(optionPremium).toBeLessThanOrEqual(capitalPools.reservePoolUsd + 1e-6);
  });

  it('has stable core artifacts present', () => {
    const required = [
      'capitalPools.json',
      'optionPositions.json',
      'optionsPlan.json',
      'budgetEnforcement.json',
      'etfOrders.json',
      'optionOrders.json',
      'executionManifest.json'
    ];
    for (const f of required) {
      expect(fs.existsSync(path.join(runDir, f))).toBe(true);
    }
    const budget = readJson<any>(path.join(runDir, 'budgetEnforcement.json'));
    expect(budget.etf).toBeTruthy();
    expect(budget.options).toBeTruthy();
    expect(budget.corePoolUsd).toBeGreaterThan(0);
    expect(budget.reservePoolUsd).toBeGreaterThan(0);
  });

  it('does not close options that are absent from positions', () => {
    const positions = readJson<{ positions: any[] }>(path.join(runDir, 'optionPositions.json')).positions || [];
    const orders = readJson<{ orders: any[] }>(path.join(runDir, 'optionOrders.json')).orders || [];
    const positionIds = new Set(
      positions.map(
        (p: any) => `${p.underlying || 'UNK'}:${p.type || 'UNK'}:${p.strike || 'UNK'}:${p.expiry || 'UNK'}`
      )
    );
    for (const o of orders) {
      if (o.action === 'CLOSE') {
        expect(positionIds.has(o.positionId)).toBe(true);
      }
    }
  });
});
