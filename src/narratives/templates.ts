import fs from 'fs';
import path from 'path';

const safeLoad = <T = any>(runId: string, file: string): T | undefined => {
  const p = path.resolve(process.cwd(), 'runs', runId, file);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return undefined;
  }
};

export const round0Summary = (runId: string) => {
  const inputs = safeLoad<any>(runId, 'inputs.json');
  const flags = safeLoad<any[]>(runId, 'round0_flags.json') || [];
  const summary = safeLoad<any>(runId, 'round0_summary.json');
  const sources = summary?.sources || inputs?.contextMeta?.sources || {};
  const macroLag = summary?.macroLagDays || {};
  const historyDepth = summary?.historyDepth || {};
  return `# Round 0 Summary

Data sources: ${Object.keys(sources).join(', ') || 'n/a'}
Universe: ${inputs?.universe?.length || 0} symbols
History depth (approx): ${JSON.stringify(historyDepth) || 'n/a'}
Macro lag (days): ${JSON.stringify(macroLag) || 'n/a'}
Flags: ${flags.length ? flags.map((f) => f.code || f).join('; ') : 'none'}

No decisions are made in Round 0.`;
};

export const round1Summary = (runId: string) => {
  const features = safeLoad<any[]>(runId, 'features.json') || [];
  const flags = safeLoad<any[]>(runId, 'round1_flags.json') || [];
  const barInterval = features[0]?.barInterval || 'weekly';
  return `# Round 1 Summary

Features computed for ${features.length} symbols using ${barInterval} bars (windows interpreted as ${barInterval} cadence).
Percentiles may be coarse when history depth is limited; flags: ${flags.length ? flags.map((f) => f.code || f).join('; ') : 'none'}.
No investment recommendations are made in this round.`;
};

export const round2Summary = (runId: string) => {
  const regimes = safeLoad<any>(runId, 'regimes.json') || {};
  const flags = safeLoad<any[]>(runId, 'round2_flags.json') || [];
  const elig = safeLoad<any>(runId, 'eligibility.json') || {};
  const eq = regimes?.equityRegime;
  return `# Round 2 Summary

Regimes are deterministic; LLM does not set regimes.
Equity regime: ${eq?.label || 'n/a'} (confidence ${eq?.confidence ?? 'n/a'}, transitionRisk ${eq?.transitionRisk || 'n/a'}).
Other regimes: vol=${regimes?.volRegime?.label || 'n/a'}, rates=${regimes?.ratesRegime?.label || 'n/a'}.
Eligibility tracked for ${Object.keys(elig).length} symbols.
Flags: ${flags.length ? flags.map((f) => f.code || f).join('; ') : 'none'}.`;
};

export const round3Summary = (runId: string) => {
  const macro = safeLoad<any>(runId, 'macro_policy.json');
  const news = safeLoad<any[]>(runId, 'news_headlines.json') || [];
  const memo = safeLoad<any>(runId, 'market_memo.json');
  const flags = safeLoad<any[]>(runId, 'round3_flags.json') || [];
  return `# Round 3 Summary

Macro policy (lag-aware): ${macro ? JSON.stringify(macro) : 'n/a'}
News headlines count: ${news.length}. Themes are contextual only.
Market memo bullets: ${(memo?.memo?.bullets || []).length || 0}
Flags: ${flags.length ? flags.map((f) => f.code || f).join('; ') : 'none'}.`;
};

export const round4Summary = (runId: string) => {
  const ctx = safeLoad<any>(runId, 'llm_context.json');
  const meta = safeLoad<any>(runId, 'context_meta.json');
  const dropped = meta?.dropped || meta?.payloadContains || {};
  return `# Round 4 Summary

Context aggregated for proposer (no decisions here).
Universe size: ${ctx?.universe?.length || 0}, features: ${ctx?.features?.length || 0}, macro included: ${!!ctx?.macro}.
Context size: ${meta?.sizeBytes || 'n/a'} bytes (max ${meta?.maxBytes || 'n/a'}). Dropped/omitted: ${JSON.stringify(dropped)}.
Constraints and eligibility included for proposer; raw macro/news URLs intentionally excluded.`;
};

export const round5Summary = (runId: string) => {
  const proposal = safeLoad<any>(runId, 'proposal.json');
  const risk = safeLoad<any>(runId, 'risk_report.json');
  const execPlan = safeLoad<any>(runId, 'execution_plan.json');
  const subs = safeLoad<any[]>(runId, 'execution_substitutions.json') || [];
  const rebalance = safeLoad<any>(runId, 'rebalance.json');
  const orders = safeLoad<any[]>(runId, 'orders.json') || [];
  const fills = safeLoad<any[]>(runId, 'fills.json') || [];
  const flags = safeLoad<any[]>(runId, 'round5_flags.json') || [];
  const buys = orders.filter((o) => o.side === 'BUY').length;
  const sells = orders.filter((o) => o.side === 'SELL').length;
  const exposure = risk?.exposureSummary?.totalNotional;
  return `# Round 5 Summary

Executive recommendation: ${buys} buys, ${sells} sells. Expected total notional: ${exposure ?? 'n/a'}.
Policy gates applied; exposure/confidence caps reflected in approved orders.
Whole-share execution: status ${execPlan?.status || 'n/a'}, proxies used: ${subs
    .filter((s) => s.reason === 'PROXY_SUBSTITUTION')
    .map((s) => `${s.originalSymbol}->${s.executedSymbol}`)
    .join(', ') || 'none'}.
Rebalance: ${rebalance?.status || 'n/a'}; drift handled with sell-first logic.
Approval state: ${fills.length ? 'fills recorded or simulated' : 'PENDING/none; no broker orders sent yet in this artifact'}.
Flags: ${flags.length ? flags.map((f) => f.code || f).join('; ') : 'none'}.`;
};
