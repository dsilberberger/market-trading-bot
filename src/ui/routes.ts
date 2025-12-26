import express from 'express';
import path from 'path';
import fs from 'fs';
import { loadConfig, loadUniverse } from '../core/utils';
import { getMarketDataProvider } from '../data/marketData';
import { buildEquityCurve } from '../analytics/performance';
import { getRecentRuns, getRunStatus, getEvents, getEventsForRun, appendEvent, makeEvent } from '../ledger/ledger';
import { readRunArtifact, writeRunArtifact } from '../ledger/storage';
import { executeOrders } from '../execution/executionEngine';
import { getBroker } from '../broker/broker';
import { BotConfig, LLMContextPacket, TradeOrder } from '../core/types';
import { getStatus as getAuthStatus, connectStart, connectFinish, renewIfPossible } from '../broker/etrade/authService';
import {
  generateBaseArtifacts,
  ensureBaseArtifacts,
  buildRound1FromInputs,
  buildRound2FromFeatures,
  buildRound3FromRegimes,
  buildRound4Context
} from '../cli/contextBuilder';
import { parseAsOfDateTime, runIdToAsOf, getRebalanceKey, isRebalanceDay, getCurrentRebalanceWindow } from '../core/time';
import { runBot } from '../cli/run';
import { preflightAuth } from '../broker/etrade/authService';
import { computeApprovalEligibility, describeReasons } from './approval';

const viewDir = path.resolve(__dirname, 'views');

  const renderTemplate = (templateName: string, vars: Record<string, string>) => {
  const layout = fs.readFileSync(path.join(viewDir, 'layout.html'), 'utf-8');
  const bodyTemplate = fs.readFileSync(path.join(viewDir, `${templateName}.html`), 'utf-8');
  const fill = (input: string) =>
    input.replace(/{{\s*(\w+)\s*}}/g, (_match, key) => {
      return vars[key] ?? '';
    });
  const body = fill(bodyTemplate);
  return fill(layout.replace('{{content}}', body));
};

const formatNumber = (val: number) => val.toLocaleString(undefined, { maximumFractionDigits: 2 });

const bannerForStatus = () => {
  const status = getAuthStatus();
  let className = 'banner-red';
  let text = `E*TRADE status: ${status.status}`;
  if (status.status === 'ACTIVE') {
    className = 'banner-green';
    text = 'E*TRADE status: ACTIVE';
  } else if (status.status === 'NEEDS_CONNECT' || status.status === 'MISSING') {
    className = 'banner-red';
    text = 'E*TRADE: connect required';
  } else if (status.status === 'INACTIVE') {
    className = 'banner-yellow';
    text = 'E*TRADE: inactive, renew may be required';
  }
  return `<div class="banner ${className}">${text}</div>`;
};

const nextRebalanceString = (cfg: BotConfig): string => {
  if (cfg.cadence === 'hourly') return 'Hourly enabled (opt-in via --asof timestamp).';
  const target = cfg.rebalanceDay?.toUpperCase?.() ?? 'FRIDAY';
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const today = new Date();
  const idx = days.indexOf(target);
  const todayIdx = today.getUTCDay();
  if (idx === -1) return `Next: ${target}`;
  let delta = idx - todayIdx;
  if (delta <= 0) delta += 7;
  const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + delta));
  return `${next.toISOString().slice(0, 10)} (${target})`;
};

const normalizeMode = (m?: string): 'paper' | 'live' | 'backtest' => {
  if (!m) return 'paper';
  const lower = m.toLowerCase();
  if (lower === 'live' || lower === 'backtest') return lower as any;
  return 'paper';
};

const readRoundState = (runId: string): { lastCompletedRound: number } => {
  const statePath = path.resolve(process.cwd(), 'runs', runId, 'round_state.json');
  if (!fs.existsSync(statePath)) return { lastCompletedRound: -1 };
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as { lastCompletedRound: number };
  } catch {
    return { lastCompletedRound: -1 };
  }
};

const writeRoundState = (runId: string, round: number) => {
  const statePath = path.resolve(process.cwd(), 'runs', runId, 'round_state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ lastCompletedRound: round }, null, 2));
};

export const registerRoutes = (app: express.Application, csrfToken: string) => {
  const configPath = path.resolve(process.cwd(), 'src/config/default.json');
  const config: BotConfig = loadConfig(configPath);
  const universe = loadUniverse(path.resolve(process.cwd(), config.universeFile));
  const encryptionEnabled = Boolean(process.env.TOKEN_STORE_ENCRYPTION_KEY);

  app.get('/', async (_req, res) => {
    const marketData = getMarketDataProvider();
    const curve = await buildEquityCurve(config, marketData);
    const latest = curve[curve.length - 1];
    const runs = getRecentRuns(20);
    // Prefer most recent run's inputs for current equity snapshot (live portfolio if available)
    let latestEquity = latest ? latest.equity : undefined;
    if (runs.length) {
      const latestRun = runs[0].runId;
      const latestInputs = readRunArtifact<{ portfolio?: { equity?: number } }>(latestRun, 'inputs.json');
      if (latestInputs?.portfolio?.equity !== undefined) {
        latestEquity = latestInputs.portfolio.equity;
      }
    }
    const rows = runs
      .map((r) => `<tr><td><a href="/runs/${r.runId}">${r.runId}</a></td><td>${r.status}</td></tr>`)
      .join('');
    const nextReb = nextRebalanceString(config);
    let regimeSnippet = 'n/a';
    let macroSnippet = 'n/a';
    if (runs.length) {
      const latestRun = runs[0].runId;
      const ctx = readRunArtifact<LLMContextPacket>(latestRun, 'llm_context.json');
      if (ctx?.regimes) {
        regimeSnippet = `growth ${ctx.regimes.growth}, inflation ${ctx.regimes.inflation}, policy ${ctx.regimes.policy}, risk ${ctx.regimes.risk}`;
      }
      if (ctx?.macroPolicy) {
        macroSnippet = JSON.stringify(ctx.macroPolicy);
      }
    }
    const content = renderTemplate('dashboard', {
      equity: latestEquity !== undefined ? formatNumber(latestEquity) : latest ? formatNumber(latest.equity) : 'n/a',
      drawdown: latest ? (latest.drawdown * 100).toFixed(2) : '0',
      exposure: latest ? (latest.exposure * 100).toFixed(2) : '0',
      runs: rows || '<tr><td colspan="2">No runs yet</td></tr>',
      defaultAsOf: new Date().toISOString().slice(0, 16),
      csrfToken,
      banner: bannerForStatus(),
      nextRebalance: nextReb,
      cadence: config.cadence,
      approval: config.requireApproval ? 'Approval required before execution.' : 'Auto-exec enabled.',
      warnAuto: config.requireApproval ? '' : 'Auto-exec enabled; review risk before trusting.',
      regime: regimeSnippet,
      macro: macroSnippet
    });
    res.send(content);
  });

  const roundRenderer = (runId: string) => {
    const readOrEmpty = (name: string) => readRunArtifact<Record<string, unknown>>(runId, name) || {};
    return {
      round0: readRunArtifact<Record<string, unknown>[]>(runId, 'round0_flags.json') || [],
      summary: readRunArtifact<Record<string, unknown>>(runId, 'round0_summary.json') || {},
      round1: readRunArtifact<Record<string, unknown>[]>(runId, 'round1_flags.json') || [],
      round2: readRunArtifact<Record<string, unknown>[]>(runId, 'round2_flags.json') || [],
      round3: readRunArtifact<Record<string, unknown>[]>(runId, 'round3_flags.json') || [],
      diagnostics: readRunArtifact<Record<string, unknown>[]>(runId, 'round0_diagnostics.json') || [],
      features: readOrEmpty('features.json'),
      regimes: readOrEmpty('regimes.json'),
      eligibility: readOrEmpty('eligibility.json'),
      news: readOrEmpty('news_headlines.json'),
      memo: readOrEmpty('market_memo.json'),
      macroPolicy: readOrEmpty('macro_policy.json'),
      context: readOrEmpty('llm_context.json'),
      proposal: readOrEmpty('proposal.json'),
      risk: readOrEmpty('risk_report.json'),
      rebalance: readOrEmpty('rebalance.json'),
      executionPlan: readOrEmpty('execution_plan.json')
    };
  };

  app.get('/runs/:date/rounds', async (req, res) => {
    const runId = req.params.date;
    const status = getRunStatus(runId);
    const data = roundRenderer(runId);
    const roundState = readRoundState(runId);
    // If legacy runs have artifacts but no state, infer a minimal state.
    const inferredState =
      roundState.lastCompletedRound === -1
        ? fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'llm_context.json'))
          ? 4
          : fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'market_memo.json'))
          ? 3
          : fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'regimes.json'))
          ? 2
          : fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'features.json'))
          ? 1
          : fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'inputs.json'))
          ? 0
          : -1
        : roundState.lastCompletedRound;
    const inputs = readRunArtifact<{ asOf: string; universe: unknown[]; portfolio?: { cash: number; equity: number } }>(
      runId,
      'inputs.json'
    );
    const r0Block = hasBlockingFlags(data.round0 as any[]);
    const r1Block = hasBlockingFlags(data.round1 as any[]);
    const r2Block = hasBlockingFlags(data.round2 as any[]);
    const r3Block = hasBlockingFlags(data.round3 as any[]);
    const inputsExists = fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'inputs.json'));
    const featureExists = fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'features.json'));
    const regimesExists = fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'regimes.json'));
    const memoExists = fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'market_memo.json'));
    const ctxExists = fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'llm_context.json'));
    const summarize = (obj: unknown) => {
      const str = JSON.stringify(obj, null, 2);
      return str.length > 1200 ? `${str.slice(0, 1200)}\n...truncated...` : str;
    };
    const featureCount = Array.isArray(data.features)
      ? data.features.length
      : Object.keys(data.features || {}).length || 0;
    const featureTable =
      Array.isArray(data.features) && data.features.length
        ? data.features
            .map((f: any) => {
              const rows = [
                `symbol=${f.symbol}`,
                `samples=${f.historySamples}`,
                `unique=${f.historyUniqueCloses}`,
                `retBucket=${f.return60dPctileBucket}`,
                `volBucket=${f.vol20dPctileBucket}`
              ];
              return rows.join(', ');
            })
            .join('\n')
        : 'n/a';
    const macroLagNote =
      config.round0MacroLagPolicy === 'summary_only'
        ? 'Macro lag tracked in summary; confidence adjusted in Round 2.'
        : '';
    const content = renderTemplate('rounds', {
      runId,
      csrfToken,
      r1Disabled:
        r0Block || !inputsExists || inferredState < 0
          ? 'disabled aria-disabled="true" class="btn-disabled"'
          : '',
      r2Disabled:
        r0Block || r1Block || !featureExists || inferredState < 1
          ? 'disabled aria-disabled="true" class="btn-disabled"'
          : '',
      r3Disabled:
        r0Block || r1Block || r2Block || !regimesExists || inferredState < 2
          ? 'disabled aria-disabled="true" class="btn-disabled"'
          : '',
      r4Disabled:
        r0Block || r1Block || r2Block || r3Block || !memoExists || inferredState < 3
          ? 'disabled aria-disabled="true" class="btn-disabled"'
          : '',
      r5Disabled:
        r0Block || r1Block || r2Block || r3Block || !ctxExists || inferredState < 4
          ? 'disabled aria-disabled="true" class="btn-disabled"'
          : '',
      round0: summarize({
        flags: data.round0,
        diagnostics: data.diagnostics,
        summary: data.summary,
        inputs: inputs
          ? { asOf: inputs.asOf, universe: inputs.universe?.length, cash: inputs.portfolio?.cash, equity: inputs.portfolio?.equity }
          : 'missing inputs.json'
      }),
      round1: summarize({ flags: data.round1, featureCount, features: data.features, summary: featureTable }),
      round2: summarize({ flags: data.round2, regimes: data.regimes, eligibility: data.eligibility }),
      round3: summarize({ flags: data.round3, news: data.news, memo: data.memo, macro: data.macroPolicy }),
      round4: summarize({ context: data.context }),
      round5: summarize({
        proposal: data.proposal,
        risk: data.risk,
        rebalance: data.rebalance
      }),
      status,
      macroLagNote
    });
    res.send(content);
  });

  const ensureRound0 = async (asOf: string, runId: string, mode: string) => {
    const configPath = path.resolve(process.cwd(), 'src/config/default.json');
    const cfg: BotConfig = loadConfig(configPath);
    const universe = loadUniverse(path.resolve(process.cwd(), cfg.universeFile));
    const md = getMarketDataProvider(mode as any);
    const broker = getBroker(cfg, md, mode as any);
    await generateBaseArtifacts(asOf, runId, cfg, universe, md, { mode }, broker);
  };

  const hasBlockingFlags = (flags: any[]): boolean =>
    (flags || []).some(
      (f) =>
        typeof f === 'object'
          ? f.action === 'block' || (f.severity && String(f.severity).toLowerCase() === 'error')
          : false
    );

  app.post('/runs/:date/round0', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    try {
      const mode = (req.body.mode || process.env.UI_DEFAULT_MODE || 'live').toLowerCase();
      await ensureRound0(asOfIso, runId, mode);
      writeRoundState(runId, 0);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Round0 failed: ${(err as Error).message}`);
    }
  });

  const roundDone = (runId: string, artifact: string) =>
    fs.existsSync(path.resolve(process.cwd(), 'runs', runId, artifact));

  app.post('/runs/:date/round1', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    if (!roundDone(runId, 'inputs.json')) return res.status(400).send('Run Round 0 first');
    const flags = readRunArtifact<any[]>(runId, 'round0_flags.json') || [];
    if (hasBlockingFlags(flags)) return res.status(400).send('Round0 has blocking data-quality flags. Fix inputs first.');
    try {
      await buildRound1FromInputs(runId);
      writeRoundState(runId, 1);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Round1 failed: ${(err as Error).message}`);
    }
  });

  app.post('/runs/:date/round2', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    if (!roundDone(runId, 'features.json')) return res.status(400).send('Run Round 1 first');
    const flags = readRunArtifact<any[]>(runId, 'round1_flags.json') || [];
    if (hasBlockingFlags(flags)) return res.status(400).send('Round1 has blocking flags. Fix inputs first.');
    try {
      await buildRound2FromFeatures(runId);
      writeRoundState(runId, 2);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Round2 failed: ${(err as Error).message}`);
    }
  });

  app.post('/runs/:date/round3', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    if (!roundDone(runId, 'regimes.json')) return res.status(400).send('Run Round 2 first');
    const flags = readRunArtifact<any[]>(runId, 'round2_flags.json') || [];
    if (hasBlockingFlags(flags)) return res.status(400).send('Round2 has blocking flags. Fix inputs first.');
    try {
      await buildRound3FromRegimes(runId);
      writeRoundState(runId, 3);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Round3 failed: ${(err as Error).message}`);
    }
  });

  app.post('/runs/:date/round4', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    if (!roundDone(runId, 'market_memo.json')) return res.status(400).send('Run Round 3 first');
    const flags = readRunArtifact<any[]>(runId, 'round3_flags.json') || [];
    if (hasBlockingFlags(flags)) return res.status(400).send('Round3 has blocking flags. Fix inputs first.');
    try {
      await buildRound4Context(runId);
      writeRoundState(runId, 4);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Round4 failed: ${(err as Error).message}`);
    }
  });

  app.post('/runs/:date/round5', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    if (!roundDone(runId, 'llm_context.json')) return res.status(400).send('Run Round 4 first');
    const round0Flags = readRunArtifact<any[]>(runId, 'round0_flags.json') || [];
    const round1Flags = readRunArtifact<any[]>(runId, 'round1_flags.json') || [];
    const round2Flags = readRunArtifact<any[]>(runId, 'round2_flags.json') || [];
    const round3Flags = readRunArtifact<any[]>(runId, 'round3_flags.json') || [];
    if ([round0Flags, round1Flags, round2Flags, round3Flags].some((f) => hasBlockingFlags(f))) {
      return res.status(400).send('Blocking flags present; fix inputs before running Round 5.');
    }
    try {
      await runBot({
        asof: asOfIso,
        mode: 'paper',
        strategy: config.useLLM ? 'llm' : 'deterministic',
        force: true,
        autoExec: !config.requireApproval,
        runId
      });
      const runDir = path.resolve(process.cwd(), 'runs', runId);
      const proposalExists = fs.existsSync(path.join(runDir, 'proposal.json'));
      const riskExists = fs.existsSync(path.join(runDir, 'risk_report.json'));
      if (!proposalExists || !riskExists) {
        writeRoundState(runId, 4);
        return res
          .status(500)
          .send('Round 5 did not produce proposal/risk artifacts. Check auth, flags, and try again.');
      }
      writeRoundState(runId, 5);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Round5 failed: ${(err as Error).message}`);
    }
  });

  app.post('/actions/start-run', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    try {
      const { asOf, runId } = parseAsOfDateTime(req.body.asof);
      const runDir = path.resolve(process.cwd(), 'runs', runId);
      if (!fs.existsSync(runDir)) {
        fs.mkdirSync(runDir, { recursive: true });
      }
      writeRoundState(runId, -1);
      res.redirect(`/runs/${runId}/rounds`);
    } catch (err) {
      res.status(500).send(`Start run failed: ${(err as Error).message}`);
    }
  });

  app.post('/runs/:date/propose', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    try {
      await runBot({
        asof: asOfIso,
        mode: 'paper',
        strategy: config.useLLM ? 'llm' : 'deterministic',
        force: true,
        autoExec: !config.requireApproval
      });
      writeRoundState(runId, 5);
      return res.redirect(`/runs/${runId}`);
    } catch (err) {
      return res.status(500).send(`Proposal failed: ${(err as Error).message}`);
    }
  });

  app.post('/actions/dump', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    try {
      const { asOf, runId } = parseAsOfDateTime(req.body.asof);
      const mode = normalizeMode(req.body.mode);
      const auth = preflightAuth(mode);
      if (!auth.allow) {
        return res.status(400).send(auth.warning || 'Auth not active');
      }
      const marketData = getMarketDataProvider(mode);
      const broker = getBroker(config, marketData, mode);
      await generateBaseArtifacts(asOf, runId, config, universe, marketData, {}, broker);
      res.redirect(`/runs/${runId}`);
    } catch (err) {
      res.status(500).send(`Dump failed: ${(err as Error).message}`);
    }
  });

  app.post('/actions/propose', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    try {
      const { asOf, runId } = parseAsOfDateTime(req.body.asof);
      const mode = normalizeMode(req.body.mode);
      const strategy = req.body.strategy || (config.useLLM ? 'llm' : 'deterministic');
      await runBot({
        asof: asOf,
        mode,
        strategy,
        force: true,
        autoExec: !config.requireApproval
      });
      res.redirect(`/runs/${runId}`);
    } catch (err) {
      res.status(500).send(`Proposal failed: ${(err as Error).message}`);
    }
  });


  app.get('/runs/:date', async (req, res) => {
    const runId = req.params.date;
    const status = getRunStatus(runId);
    const inputs = readRunArtifact<Record<string, unknown>>(runId, 'inputs.json');
    const proposal = readRunArtifact<Record<string, unknown>>(runId, 'proposal.json');
    const risk = readRunArtifact<Record<string, unknown>>(runId, 'risk_report.json');
    const rebalance = readRunArtifact<Record<string, unknown>>(runId, 'rebalance.json');
    const dislocation = readRunArtifact<Record<string, unknown>>(runId, 'dislocation.json');
    const orders = readRunArtifact<TradeOrder[]>(runId, 'orders.json') || [];
    const fills = readRunArtifact<Record<string, unknown>[]>(runId, 'fills.json') || [];
    const placements = readRunArtifact<Record<string, unknown>[]>(runId, 'placements.json') || [];
    const llmContext = readRunArtifact<Record<string, unknown>>(runId, 'llm_context.json');
    const meta = readRunArtifact<Record<string, unknown>>(runId, 'context_meta.json');
    const asOfIso = runIdToAsOf(runId);
    const events = getEventsForRun(runId)
      .map((e) => `<li>${e.timestamp} - ${e.type}</li>`)
      .join('');

    const hasProposal = Boolean(proposal);
    const hasRisk = Boolean(risk);
    const features = readRunArtifact<any[]>(runId, 'features.json') || [];
    const featureRows = Array.isArray(features)
      ? features
          .map(
            (f: any) =>
              `<tr><td>${f.symbol}</td><td>${f.historySamples ?? 'n/a'}</td><td>${f.historyUniqueCloses ?? 'n/a'}</td><td>${
                f.return60dPctileBucket ?? 'n/a'
              }</td><td>${f.vol20dPctileBucket ?? 'n/a'}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="5">n/a</td></tr>';

    const fillPaid: Record<string, number> = {};
    const fillStatus: Record<string, string> = {};
    const estPaid: Record<string, number> = {};
    fills.forEach((f: any) => {
      const sym = f?.symbol;
      const notional = Number(f?.notional || 0);
      const qty = Number(f?.quantity || 0);
      if (sym && notional > 0) {
        fillPaid[sym] = (fillPaid[sym] || 0) + notional;
      }
      if (sym && qty > 0) {
        fillStatus[sym] = 'FILLED';
      }
    });
    // If no fills yet, fall back to placement estimate
    placements.forEach((p: any) => {
      const sym = p?.symbol;
      const est = Number(
        p?.raw?.PlaceOrderResponse?.Order?.[0]?.estimatedTotalAmount ??
          p?.estimatedCost ??
          0
      );
      if (sym && !fillPaid[sym] && est > 0) {
        estPaid[sym] = est;
      }
    });

    const orderRows =
      orders.length > 0
        ? orders
            .map((o) => {
              const filledAmt = fillPaid[o.symbol];
              const estAmt = estPaid[o.symbol];
              const paidCell = filledAmt
                ? `Filled $${filledAmt.toFixed(2)}`
                : estAmt
                ? `Est $${estAmt.toFixed(2)}`
                : '—';
              return `<tr><td>${o.symbol}</td><td>${o.side}</td><td>${o.orderType}</td><td>$${o.notionalUSD.toFixed(
                2
              )}</td><td>${paidCell}</td><td>${o.thesis}</td></tr>`;
            })
            .join('')
        : '<tr><td colspan="6">No orders</td></tr>';

    const rebalanceRows =
      rebalance && (rebalance as any).combinedOrders && Array.isArray((rebalance as any).combinedOrders)
        ? (rebalance as any).combinedOrders
            .map((o: any) => {
              const reason = o.reason || (o.side === 'SELL' ? 'Trim to target' : 'Rebalance add');
              return `<tr><td>${o.symbol}</td><td>${o.side}</td><td>$${o.notionalUSD?.toFixed?.(2) ?? ''}</td><td>${reason}</td></tr>`;
            })
            .join('')
        : '<tr><td colspan="4">No rebalance orders</td></tr>';

    let riskSummary = 'n/a';
    if (risk && (risk as any).approved !== undefined) {
      const approved = (risk as any).approved;
      const reasons = (risk as any).blockedReasons as string[];
      riskSummary = approved ? 'APPROVED' : `BLOCKED: ${reasons?.join('; ') || 'unknown reason'}`;
    }

    const proposeForm = hasProposal
      ? ''
      : `<form method="POST" action="/runs/${runId}/propose"><input type="hidden" name="csrfToken" value="${csrfToken}"/><input type="hidden" name="asof" value="${asOfIso}"/><button type="submit">Run proposal for this dump</button></form>`;
    const stageNotice = !hasProposal
      ? `Proposal missing; run it for this as-of. ${proposeForm}`
      : !hasRisk
      ? `Risk report missing; rerun proposal to regenerate. ${proposeForm}`
      : risk && (risk as any).approved === false
      ? `Risk blocked: ${(risk as any).blockedReasons?.join('; ') || 'unknown reason'}`
      : '';

    const loadFlags = (name: string) => readRunArtifact<any[]>(runId, name) || [];
    const flagToText = (f: any) =>
      typeof f === 'string' ? f : `${f.severity ?? 'info'}: ${f.message ?? f.code ?? 'flag'}`;
    const flags = {
      round0: loadFlags('round0_flags.json'),
      round1: loadFlags('round1_flags.json'),
      round2: loadFlags('round2_flags.json'),
      round3: loadFlags('round3_flags.json')
    };
    const flagList = Object.entries(flags)
      .map(
        ([round, arr]) =>
          `<tr><td>${round}</td><td>${arr.length ? arr.map((f) => `<div>${flagToText(f)}</div>`).join('') : 'OK'}</td></tr>`
      )
      .join('');

    const stages = [
      { name: 'Round 0 - Dump', ok: Boolean(inputs) },
      { name: 'Round 1 - Features', ok: fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'features.json')) },
      {
        name: 'Round 2 - Regimes/Eligibility',
        ok: fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'regimes.json'))
      },
      { name: 'Round 3 - Memo/News', ok: fs.existsSync(path.resolve(process.cwd(), 'runs', runId, 'market_memo.json')) },
      { name: 'Round 4 - Final Context', ok: Boolean(llmContext) },
      { name: 'Round 5 - Proposal/Risk', ok: hasProposal && hasRisk }
    ];
    const timeline = stages.map((s) => `<li>${s.ok ? '✅' : '⏳'} ${s.name}</li>`).join('');

    const eligibility = computeApprovalEligibility(runId, config);
    const eligibilityReasons = eligibility.reasons.length
      ? `<ul>${describeReasons(eligibility.reasons)
          .map((r) => `<li>${r}</li>`)
          .join('')}</ul>`
      : '<div class="banner banner-green">Eligible for approval today.</div>';
    const approveDisabled = eligibility.eligible ? '' : 'disabled aria-disabled="true" class="btn-disabled"';
    const defaultMode = process.env.UI_DEFAULT_MODE || 'paper';
    const modeSelect = (modeDefault?: string) => `
      <label>Mode:
        <select name="mode">
          <option value="paper" ${(modeDefault || defaultMode) === 'paper' ? 'selected' : ''}>paper</option>
          <option value="live" ${(modeDefault || defaultMode) === 'live' ? 'selected' : ''}>live</option>
        </select>
      </label>`;
    const overrideForm = !eligibility.eligible
      ? `<form method="POST" action="/runs/${runId}/approve?override=1">
          <input type="hidden" name="csrfToken" value="${csrfToken}"/>
          ${modeSelect(req.query.mode as string | undefined)}
          <label>Type APPROVE to override: <input type="text" name="confirm" /></label>
          <button type="submit">Force Approve</button>
         </form>`
      : '';
    const approveButtons =
      status === 'PENDING_APPROVAL'
        ? eligibility.eligible
          ? `<div class="card">
               <div><strong>Approval gating</strong></div>
               <div>Rebalance day: ${config.rebalanceDay || 'TUESDAY'} | Window: ${eligibility.window.startISO} → ${eligibility.window.endISO}</div>
               ${eligibilityReasons}
               <form method="POST" action="/runs/${runId}/approve">
                  <input type="hidden" name="csrfToken" value="${csrfToken}"/>
                  ${modeSelect(req.query.mode as string | undefined)}
                  <button type="submit" ${approveDisabled}>Approve</button>
               </form>
               <form method="POST" action="/runs/${runId}/reject"><input type="hidden" name="csrfToken" value="${csrfToken}"/><button type="submit">Reject</button></form>
             </div>`
          : `<div class="card">
               <div><strong>Approval gating</strong></div>
               <div>Rebalance day: ${config.rebalanceDay || 'TUESDAY'} | Window: ${eligibility.window.startISO} → ${eligibility.window.endISO}</div>
               ${eligibilityReasons}
               <form method="POST" action="/runs/${runId}/approve?override=1">
                  <input type="hidden" name="csrfToken" value="${csrfToken}"/>
                  ${modeSelect(req.query.mode as string | undefined)}
                  <label>Type APPROVE to override: <input type="text" name="confirm" /></label>
                  <button type="submit">Force Approve</button>
               </form>
               <form method="POST" action="/runs/${runId}/reject"><input type="hidden" name="csrfToken" value="${csrfToken}"/><button type="submit">Reject</button></form>
             </div>`
        : '';

    const content = renderTemplate('run', {
      runId,
      status,
      inputs: inputs ? JSON.stringify(inputs, null, 2) : 'n/a',
      proposal: proposal ? JSON.stringify(proposal, null, 2) : 'n/a',
      risk: risk ? JSON.stringify(risk, null, 2) : 'n/a',
      orders: JSON.stringify(orders, null, 2),
      fills: JSON.stringify(fills, null, 2),
      llm: llmContext ? JSON.stringify(llmContext, null, 2) : 'n/a',
      meta: meta ? JSON.stringify(meta, null, 2) : 'n/a',
      dislocation: dislocation ? JSON.stringify(dislocation, null, 2) : 'n/a',
      events,
      approval: approveButtons,
      orderTable: orderRows,
      rebalanceRows,
      featureRows,
      riskSummary,
      stageNotice,
      timeline,
      csrfToken,
      banner: bannerForStatus()
    });
    res.send(content);
  });

  app.get('/runs/:date/approval-eligibility', (req, res) => {
    const runId = req.params.date;
    const eligibility = computeApprovalEligibility(runId, config);
    res.json(eligibility);
  });

  app.post('/runs/:date/approve', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) {
      return res.status(403).send('Invalid CSRF token');
    }
    const runId = req.params.date;
    const status = getRunStatus(runId);
    if (status === 'COMPLETED' || status === 'REJECTED') {
      return res.redirect(`/runs/${runId}`);
    }
    const orders = readRunArtifact<TradeOrder[]>(runId, 'orders.json') || [];
    const asOfIso = runIdToAsOf(runId);
    const mode = normalizeMode(req.body.mode || (req.query as any)?.mode || process.env.UI_DEFAULT_MODE);
    const marketData = getMarketDataProvider(mode as any);
    const config: BotConfig = loadConfig(configPath);
    const broker = getBroker(config, marketData, mode as any);
    const eligibility = computeApprovalEligibility(runId, config);
    const override = req.query.override === '1';
    const confirmed = (req.body.confirm || '').trim().toUpperCase() === 'APPROVE';
    if (!eligibility.eligible) {
      if (!override || !confirmed) {
        return res
          .status(409)
          .send(
            `Approval blocked: ${describeReasons(eligibility.reasons).join(
              '; '
            )}. Rebalance day is ${config.rebalanceDay || 'TUESDAY'}. To override, resubmit with confirm=APPROVE.`
          );
      }
      appendEvent(
        makeEvent(runId, 'APPROVAL_OVERRIDE_USED', {
          rebalanceKey: eligibility.rebalanceKey,
          reasons: eligibility.reasons,
          confirmed: true
        })
      );
    }
    appendEvent(makeEvent(runId, 'RUN_APPROVED', { by: 'ui', mode }));
    await executeOrders(runId, asOfIso, orders, broker, config, {
      dryRun: false,
      mode,
      brokerProvider: (process.env.BROKER_PROVIDER || 'stub').toLowerCase()
    });
    appendEvent(makeEvent(runId, 'RUN_COMPLETED', { fills: orders.length }));
    res.redirect(`/runs/${runId}`);
  });

  // Trigger fill sync for a run
  app.post('/runs/:date/sync-fills', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) {
      return res.status(403).send('Invalid CSRF token');
    }
    const runId = req.params.date;
    const asOfIso = runIdToAsOf(runId);
    try {
      const placements = readRunArtifact<any[]>(runId, 'placements.json') || [];
      if (!placements.length) {
        return res.status(400).send('No placements.json found for this run.');
      }
      const orderIds = placements.map((p) => String(p.orderId));
      const marketData = getMarketDataProvider('live' as any);
      const broker = getBroker(config, marketData, 'live' as any);
      const fills = await broker.getFills(orderIds, asOfIso);
      writeRunArtifact(runId, 'fills.json', fills);
      for (const fill of fills) {
        appendEvent(makeEvent(runId, 'FILL_RECORDED', { fill }));
      }
      res.redirect(`/runs/${runId}`);
    } catch (err) {
      res.status(500).send(`Fill sync failed: ${(err as Error).message}`);
    }
  });

  app.post('/runs/:date/reject', express.urlencoded({ extended: true }), (req, res) => {
    if (req.body.csrfToken !== csrfToken) {
      return res.status(403).send('Invalid CSRF token');
    }
    const runId = req.params.date;
    appendEvent(makeEvent(runId, 'RUN_REJECTED', { by: 'ui' }));
    res.redirect(`/runs/${runId}`);
  });

  app.get('/ledger', (_req, res) => {
    const events = getEvents()
      .slice(-200)
      .reverse()
      .map((e) => `<tr><td>${e.timestamp}</td><td>${e.runId}</td><td>${e.type}</td></tr>`)
      .join('');
    const content = renderTemplate('ledger', {
      events: events || '<tr><td colspan="3">No events</td></tr>',
      csrfToken,
      banner: bannerForStatus()
    });
    res.send(content);
  });

  app.get('/reports', (_req, res) => {
    const performancePath = fs.existsSync(path.resolve(process.cwd(), 'reports/performance.csv'))
      ? '/reports/performance.csv'
      : '#';
    const summaryPath = fs.existsSync(path.resolve(process.cwd(), 'reports/summary.json'))
      ? '/reports/summary.json'
      : '#';
    const links = `\n      <li><a href="${performancePath}">performance.csv</a></li>\n      <li><a href="${summaryPath}">summary.json</a></li>\n    `;
    const content = renderTemplate('reports', { links, csrfToken, banner: bannerForStatus() });
    res.send(content);
  });

  app.get('/auth', (_req, res) => {
    const status = getAuthStatus();
    const content = renderTemplate('auth', {
      status: `${status.status} ${status.statusReason ?? ''}`,
      env: (process.env.ETRADE_ENV as string) || 'sandbox',
      access: status.access_token ? status.access_token : 'none',
      request: status.oauth_token ? status.oauth_token : 'none',
      authorizeUrl: '',
      oauthToken: status.oauth_token ?? '',
      message: '',
      warning: encryptionEnabled
        ? 'Token store encrypted at rest.'
        : 'Token store NOT encrypted. Set TOKEN_STORE_ENCRYPTION_KEY to encrypt.',
      csrfToken,
      banner: bannerForStatus()
    });
    res.send(content);
  });

  app.get('/help', (_req, res) => {
    const content = renderTemplate('help', {
      csrfToken,
      banner: bannerForStatus()
    });
    res.send(content);
  });

  app.post('/auth/connect', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    try {
      const { authorizeUrl, oauthToken } = await connectStart();
      const status = getAuthStatus();
      const content = renderTemplate('auth', {
        status: `${status.status} ${status.statusReason ?? ''}`,
        env: (process.env.ETRADE_ENV as string) || 'sandbox',
        access: status.access_token ? status.access_token : 'none',
        request: status.oauth_token ? status.oauth_token : 'none',
        authorizeUrl,
        oauthToken,
        message: 'Click authorize to continue.',
        warning: encryptionEnabled
          ? 'Token store encrypted at rest.'
          : 'Token store NOT encrypted. Set TOKEN_STORE_ENCRYPTION_KEY to encrypt.',
        csrfToken,
        banner: bannerForStatus()
      });
      res.send(content);
    } catch (err) {
      res.status(500).send(`E*TRADE connect failed: ${(err as Error).message}`);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const oauthVerifier = req.query.oauth_verifier as string | undefined;
    if (!oauthVerifier) return res.status(400).send('Missing oauth_verifier');
    try {
      await connectFinish(oauthVerifier);
      const status = getAuthStatus();
      const content = renderTemplate('auth', {
        status: `${status.status} ${status.statusReason ?? ''}`,
        env: (process.env.ETRADE_ENV as string) || 'sandbox',
        access: status.access_token ? status.access_token : 'none',
        request: status.oauth_token ? status.oauth_token : 'none',
        authorizeUrl: '',
        oauthToken: '',
        message: 'Authorization complete.',
        warning: encryptionEnabled
          ? 'Token store encrypted at rest.'
          : 'Token store NOT encrypted. Set TOKEN_STORE_ENCRYPTION_KEY to encrypt.',
        csrfToken,
        banner: bannerForStatus()
      });
      res.send(content);
    } catch (err) {
      res.status(500).send(`E*TRADE callback failed: ${(err as Error).message}`);
    }
  });

  app.post('/auth/callback', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    const oauthVerifier = req.body.oauth_verifier as string | undefined;
    if (!oauthVerifier) return res.status(400).send('Missing oauth_verifier');
    try {
      await connectFinish(oauthVerifier);
      const status = getAuthStatus();
      const content = renderTemplate('auth', {
        status: `${status.status} ${status.statusReason ?? ''}`,
        env: (process.env.ETRADE_ENV as string) || 'sandbox',
        access: status.access_token ? status.access_token : 'none',
        request: status.oauth_token ? status.oauth_token : 'none',
        authorizeUrl: '',
        oauthToken: '',
        message: 'Authorization complete.',
        warning: encryptionEnabled
          ? 'Token store encrypted at rest.'
          : 'Token store NOT encrypted. Set TOKEN_STORE_ENCRYPTION_KEY to encrypt.',
        csrfToken,
        banner: bannerForStatus()
      });
      res.send(content);
    } catch (err) {
      res.status(500).send(`E*TRADE callback failed: ${(err as Error).message}`);
    }
  });

  app.post('/auth/renew', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.body.csrfToken !== csrfToken) return res.status(403).send('Invalid CSRF token');
    try {
      await renewIfPossible();
      const status = getAuthStatus();
      const content = renderTemplate('auth', {
        status: `${status.status} ${status.statusReason ?? ''}`,
        env: (process.env.ETRADE_ENV as string) || 'sandbox',
        access: status.access_token ? status.access_token : 'none',
        request: status.oauth_token ? status.oauth_token : 'none',
        authorizeUrl: '',
        oauthToken: '',
        message: 'Renew attempted.',
        warning: encryptionEnabled
          ? 'Token store encrypted at rest.'
          : 'Token store NOT encrypted. Set TOKEN_STORE_ENCRYPTION_KEY to encrypt.',
        csrfToken,
        banner: bannerForStatus()
      });
      res.send(content);
    } catch (err) {
      res.status(500).send(`E*TRADE renew failed: ${(err as Error).message}`);
    }
  });
};
