import fs from 'fs';
import path from 'path';
import { BotConfig, LLMContextPacket, PortfolioState, TradeIntent, TradeOrder } from '../core/types';

export interface PolicyGateResult {
  orders: TradeOrder[];
  flags: { code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: Record<string, unknown> }[];
  policyApplied: Record<string, unknown>;
  blockedReasons?: string[];
}

const loadRound0Summary = (runId: string): { macroLagDays?: Record<string, number> } => {
  const p = path.resolve(process.cwd(), 'runs', runId, 'round0_summary.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
};

const sumBuyNotional = (orders: TradeOrder[]) =>
  orders.filter((o) => o.side === 'BUY').reduce((acc, o) => acc + (o.notionalUSD || 0), 0);

export const applyDecisionPolicyGate = (
  intent: TradeIntent,
  llmContext: LLMContextPacket,
  portfolio: PortfolioState,
  config: BotConfig,
  dislocation?: { active?: boolean; metrics?: any }
): PolicyGateResult => {
  const flags: PolicyGateResult['flags'] = [];
  const blockedReasons: string[] = [];
  let orders = intent.orders.map((o) => ({ ...o }));
  const runId = intent.asOf.replace(/:/g, '-');
  const round0Summary = loadRound0Summary(runId);
  const macroLagDays = round0Summary.macroLagDays || {};
  const macroLagWarn = config.macroLagWarnDays ?? 45;
  const hasMacroLag = Object.values(macroLagDays).some((d) => (d ?? 0) > macroLagWarn);
  const hasCoarsePercentiles =
    llmContext.dataQuality?.round1?.some((f) => f.code === 'COARSE_PERCENTILES' || f.code === 'PERCENTILE_UNRELIABLE') ??
    false;
  const equityConf = llmContext.regimes?.equityRegime?.confidence ?? 0.5;
  const transitionRisk = llmContext.regimes?.equityRegime?.transitionRisk ?? 'low';

  // Exposure cap
  let exposureCap = 1.0;
  const netExposureTarget = intent.orders[0]?.portfolioLevel?.netExposureTarget;
  if (netExposureTarget !== undefined) exposureCap = Math.min(exposureCap, netExposureTarget);
  if (equityConf < 0.35) exposureCap = Math.min(exposureCap, 0.35);
  else if (equityConf < 0.6) exposureCap = Math.min(exposureCap, 0.6);
  if (hasMacroLag) exposureCap = Math.min(exposureCap, 0.7);
  if (hasCoarsePercentiles) exposureCap = Math.min(exposureCap, 0.7);
  if (transitionRisk === 'high') exposureCap = Math.min(exposureCap, 0.35);
  else if (transitionRisk === 'elevated') exposureCap = Math.min(exposureCap, 0.6);

  const baseExposureCap = exposureCap;
  if (dislocation?.active && config.dislocation?.enabled) {
    const extra = config.dislocation.opportunisticExtraExposurePct ?? 0;
    const maxTotal = config.dislocation.maxTotalExposureCapPct ?? 1.0;
    const newCap = Math.min(maxTotal, exposureCap + extra);
    if (newCap > exposureCap) {
      exposureCap = newCap;
      flags.push({
        code: 'OPPORTUNISTIC_EXPOSURE_ADDED',
        severity: 'info',
        message: 'Dislocation active; exposure cap increased',
        observed: { baseExposureCap, newCap }
      });
    }
  }

  // Confidence cap
  let confidenceCap = 1.0;
  if (equityConf < 0.35) confidenceCap = Math.min(confidenceCap, 0.55);
  if (hasMacroLag) confidenceCap = Math.min(confidenceCap, 0.7);
  if (hasCoarsePercentiles) confidenceCap = Math.min(confidenceCap, 0.7);
  if (transitionRisk === 'high') confidenceCap = Math.min(confidenceCap, 0.55);

  // Apply confidence cap and drop very low
  let confidenceCapped = false;
  orders = orders
    .map((o) => {
      const capped = Math.min(o.confidence ?? 1, confidenceCap);
      if (capped < (o.confidence ?? 1)) confidenceCapped = true;
      return { ...o, confidence: capped };
    })
    .filter((o) => o.confidence === undefined || o.confidence >= 0.35);
  if (confidenceCapped) {
    flags.push({
      code: 'CONFIDENCE_CAPPED',
      severity: 'warn',
      message: 'Order confidences capped based on regime/data quality',
      observed: { confidenceCap }
    });
  }

  // Enforce min cash
  const minCashReq = portfolio.equity * (config.minCashPct ?? 0);
  const available = Math.max(0, portfolio.cash - minCashReq);
  const capNotional = portfolio.equity * exposureCap;
  const currentBuy = sumBuyNotional(orders);
  const maxSpend = Math.min(available, capNotional);

  const mode = config.policyGateMode || 'scale';
  const blockByPolicy =
    mode === 'block' &&
    exposureCap < 1 &&
    (equityConf < 0.6 || hasMacroLag || hasCoarsePercentiles || transitionRisk === 'elevated' || transitionRisk === 'high');

  if (blockByPolicy) {
    orders = [];
    blockedReasons.push('Policy gate blocked execution due to low confidence/data quality');
    flags.push({
      code: 'POLICY_BLOCKED_LOW_CONFIDENCE',
      severity: 'warn',
      message: 'Exposure capped; blocking run instead of scaling',
      observed: { exposureCap, equityConf, hasMacroLag, hasCoarsePercentiles, transitionRisk }
    });
  } else if (currentBuy > maxSpend && currentBuy > 0) {
    const scale = maxSpend / currentBuy;
    orders = orders.map((o) => (o.side === 'BUY' ? { ...o, notionalUSD: o.notionalUSD * scale } : o));
    flags.push({
      code: 'EXPOSURE_DAMPENED',
      severity: 'warn',
      message: 'Scaled buys to respect exposure/cash caps',
      observed: { requested: currentBuy, maxSpend, exposureCap }
    });
  }

  if (exposureCap <= 0.35 && currentBuy > portfolio.equity * 0.7) {
    flags.push({
      code: 'BASELINE_CONFLICT',
      severity: 'warn',
      message: 'Exposure request conflicts with low confidence cap',
      observed: { exposureCap }
    });
  }

  const policyApplied = {
    exposureCap,
    confidenceCap,
    hasMacroLag,
    hasCoarsePercentiles,
    transitionRisk,
    equityConf,
    baseExposureCap
  };

  return { orders, flags, policyApplied, blockedReasons };
};
