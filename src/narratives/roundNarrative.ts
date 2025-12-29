import fs from 'fs';
import path from 'path';
import { mdSection, bulletList, defaultFooter, safeLoadJson } from './templates';

const write = (p: string, content: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

const ensure = (runDir: string, file: string) => path.join(runDir, file);

const round0Summary = (runDir: string) => {
  const inputs = safeLoadJson<any>(ensure(runDir, 'inputs.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round0_flags.json')) || [];
  const summary: string[] = [];
  if (inputs) {
    summary.push(`As of: ${inputs.asOf || 'n/a'}`);
    summary.push(`Universe size: ${inputs.universe?.length || 0}`);
    summary.push(`History keys: ${Object.keys(inputs.history || {}).length}`);
    if (inputs.config) summary.push(`Config source: default.json (rebalanceDay ${inputs.config.rebalanceDay || 'n/a'})`);
  }
  if (flags.length) summary.push('Flags:\n' + bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  summary.push('Decisions: none (raw intake only).');
  return mdSection('Round 0 (raw intake)', summary.join('\n')) + defaultFooter();
};

const round1Summary = (runDir: string) => {
  const feats = safeLoadJson<any[]>(ensure(runDir, 'features.json')) || [];
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round1_flags.json')) || [];
  const summary: string[] = [];
  summary.push(`Features computed for ${feats.length} symbols.`);
  if (feats.length) summary.push(`Sample cadence: treated as weekly bars; percentiles are coarse.`);
  if (flags.length) summary.push('Flags:\n' + bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  return mdSection('Round 1 (features)', summary.join('\n')) + defaultFooter();
};

const round2Summary = (runDir: string) => {
  const regimes = safeLoadJson<any>(ensure(runDir, 'regimes.json'));
  const eligibility = safeLoadJson<any>(ensure(runDir, 'eligibility.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round2_flags.json')) || [];
  const summary: string[] = [];
  if (regimes?.equityRegime) {
    summary.push(
      `Equity regime: ${regimes.equityRegime.label || 'n/a'} (conf ${
        regimes.equityRegime.confidence ?? 'n/a'
      })`
    );
  }
  if (regimes?.volRegime)
    summary.push(`Vol regime: ${regimes.volRegime.label || 'n/a'} (conf ${regimes.volRegime.confidence ?? 'n/a'})`);
  if (eligibility) summary.push(`Eligibility entries: ${Object.keys(eligibility).length}`);
  if (flags.length) summary.push('Flags:\n' + bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  summary.push('Regimes are deterministic; LLM does not set regimes.');
  return mdSection('Round 2 (regimes & eligibility)', summary.join('\n')) + defaultFooter();
};

const round3Summary = (runDir: string) => {
  const macro = safeLoadJson<any>(ensure(runDir, 'macro_policy.json'));
  const memo = safeLoadJson<any>(ensure(runDir, 'market_memo.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round3_flags.json')) || [];
  const summary: string[] = [];
  if (macro) summary.push(`Macro policy points: ${Object.keys(macro).length}`);
  if (memo?.memo?.bullets) summary.push(`Memo bullets: ${memo.memo.bullets.length}`);
  if (memo?.memo?.key_risks) summary.push(`Key risks: ${memo.memo.key_risks.length}`);
  if (flags.length) summary.push('Flags:\n' + bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  return mdSection('Round 3 (macro/news memo)', summary.join('\n')) + defaultFooter();
};

const round4Summary = (runDir: string) => {
  const ctx = safeLoadJson<any>(ensure(runDir, 'llm_context.json'));
  const meta = safeLoadJson<any>(ensure(runDir, 'context_meta.json'));
  const summary: string[] = [];
  if (ctx?.portfolio) summary.push('Context includes portfolio snapshot.');
  if (meta) {
    const payloadKeys = Object.keys(meta.payloadContains || {}).filter((k) => meta.payloadContains[k]);
    summary.push(`Payload contains: ${payloadKeys.join(', ') || 'n/a'}`);
  }
  summary.push('Aggregation only; no decisions here.');
  return mdSection('Round 4 (context aggregation)', summary.join('\n') || 'No context') + defaultFooter();
};

const round5Summary = (runDir: string) => {
  const proposal = safeLoadJson<any>(ensure(runDir, 'proposal.json'));
  const risk = safeLoadJson<any>(ensure(runDir, 'risk_report.json'));
  const execPlan = safeLoadJson<any>(ensure(runDir, 'execution_plan.json'));
  const flags = safeLoadJson<any[]>(ensure(runDir, 'round5_flags.json')) || [];
  const lines: string[] = [];
  if (proposal?.intent?.orders) lines.push(`Orders proposed: ${proposal.intent.orders.length}`);
  if (risk?.approved !== undefined) lines.push(`Risk approved: ${risk.approved}`);
  if (proposal?.intent?.orders?.length) {
    const buys = proposal.intent.orders.filter((o: any) => o.side === 'BUY').length;
    const sells = proposal.intent.orders.filter((o: any) => o.side === 'SELL').length;
    lines.push(`Proposed buys: ${buys}, sells: ${sells}`);
  }
  if (execPlan?.orders) lines.push(`Execution orders: ${execPlan.orders.length}`);
  if (flags.length) lines.push('Flags:\n' + bulletList(flags.map((f) => `${f.code || f}: ${f.message || ''}`)));
  return mdSection('Round 5 (proposal/risk/execution)', lines.join('\n')) + defaultFooter();
};

const summaryByRound = (runDir: string, round: number): string => {
  switch (round) {
    case 0:
      return round0Summary(runDir);
    case 1:
      return round1Summary(runDir);
    case 2:
      return round2Summary(runDir);
    case 3:
      return round3Summary(runDir);
    case 4:
      return round4Summary(runDir);
    case 5:
      return round5Summary(runDir);
    default:
      return '';
  }
};

export const writeRoundSummaries = (runId: string, baseDir = process.cwd()) => {
  const runDir = path.join(baseDir, 'runs', runId);
  [0, 1, 2, 3, 4, 5].forEach((r) => {
    const content = summaryByRound(runDir, r);
    if (content) write(path.join(runDir, `round${r}_summary.md`), content);
  });
};

// Backward-compatible name used by run.ts imports; supports optional round selection
export const generateRoundNarrative = (runId: string, round?: number, baseDir = process.cwd()) => {
  if (round === undefined) return writeRoundSummaries(runId, baseDir);
  const runDir = path.join(baseDir, 'runs', runId);
  const content = summaryByRound(runDir, round);
  if (content) write(path.join(runDir, `round${round}_summary.md`), content);
};
