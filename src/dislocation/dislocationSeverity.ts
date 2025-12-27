import { BotConfig, PriceBar } from '../core/types';

export interface DislocationSeverity {
  tier: number;
  tierName: string;
  overlayExtraExposurePct: number;
  tierEngaged: boolean;
  metrics: {
    peakDrawdownPct: number;
    fastDrawdownPct: number;
    slowDrawdownPct: number;
  };
}

const pct = (num: number) => (Number.isFinite(num) ? num : 0);

const drawdownFromPeak = (series: PriceBar[], lookback: number): number => {
  const closes = series.slice(-lookback).map((b) => b.close);
  if (!closes.length) return 0;
  const peak = Math.max(...closes);
  const current = closes[closes.length - 1];
  if (!peak || current === undefined) return 0;
  return (peak - current) / peak;
};

const oneBarDrop = (series: PriceBar[]): number => {
  if (series.length < 2) return 0;
  const prev = series[series.length - 2].close;
  const current = series[series.length - 1].close;
  if (!prev) return 0;
  return (prev - current) / prev;
};

export const computeDislocationSeverity = (
  history: PriceBar[] | undefined,
  config: BotConfig
): DislocationSeverity => {
  const cfg = config.dislocation || {};
  const tiers = cfg.tiers || [];
  const series = history || [];
  const peakLookback = cfg.peakLookbackWeeks || 26;
  const fastWindow = cfg.fastWindowWeeks || 1;
  const slowWindow = cfg.slowWindowWeeks || 4;

  const peakDrawdownPct = pct(drawdownFromPeak(series, Math.min(series.length, peakLookback)));
  const fastDrawdownPct = pct(oneBarDrop(series.slice(-Math.max(2, fastWindow + 1))));
  const slowDrawdownPct = pct(drawdownFromPeak(series, Math.min(series.length, slowWindow)));

  // base tier from peak drawdown
  let tier = 0;
  for (const t of tiers) {
    if (peakDrawdownPct >= t.peakDrawdownGte) tier = Math.max(tier, t.tier);
  }

  // fast escalation
  if (cfg.fastDrawdownEscalation?.enabled) {
    if (fastDrawdownPct >= (cfg.fastDrawdownEscalation.tier3FastDrawdownGte || 0.18)) tier = Math.max(tier, 3);
    else if (fastDrawdownPct >= (cfg.fastDrawdownEscalation.tier2FastDrawdownGte || 0.12)) tier = Math.max(tier, 2);
  }
  // slow escalation
  if (cfg.slowDrawdownEscalation?.enabled) {
    if (slowDrawdownPct >= (cfg.slowDrawdownEscalation.tier3SlowDrawdownGte || 0.25)) tier = Math.max(tier, 3);
    else if (slowDrawdownPct >= (cfg.slowDrawdownEscalation.tier2SlowDrawdownGte || 0.15)) tier = Math.max(tier, 2);
  }

  const tierCfg = tiers.find((t) => t.tier === tier) || { name: 'inactive', overlayExtraExposurePct: 0 };
  const minActiveTier = cfg.minActiveTier ?? 0;
  const tierEngaged = tier >= minActiveTier;

  return {
    tier,
    tierName: tierCfg.name || 'inactive',
    overlayExtraExposurePct: tierCfg.overlayExtraExposurePct || 0,
    tierEngaged,
    metrics: { peakDrawdownPct, fastDrawdownPct, slowDrawdownPct }
  };
};
