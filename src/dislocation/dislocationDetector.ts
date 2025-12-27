import fs from 'fs';
import path from 'path';
import { BotConfig, PriceBar } from '../core/types';
import { computeDislocationSeverity } from './dislocationSeverity';

export interface DislocationResult {
  asOf: string;
  tierEngaged: boolean;
  active?: boolean;
  tier?: number;
  tierName?: string;
  overlayExtraExposurePct?: number;
  triggeredThisRun: boolean;
  reason: string[];
  metrics: {
    spyDrawdownFastPct: number;
    spyDrawdownSlowPct: number;
    peakDrawdownPct?: number;
    breadthConfirm?: { symbolsChecked: string[]; downCount: number };
    troughDate?: string;
    troughPrice?: number;
    anchorPrice?: number;
  };
  window: {
    startISO: string;
    expiresISO: string;
    remainingWeeks: number;
  };
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

interface DislocationState {
  active?: boolean;
  windowStartISO?: string;
  expiresISO?: string;
  triggeredAtRun?: string;
  troughPrice?: number;
  troughDate?: string;
  anchorSymbol?: string;
  cooldownUntilISO?: string;
}

const statePath = path.resolve(process.cwd(), 'data_cache', 'dislocation_state.json');

const loadState = (): DislocationState => {
  try {
    if (!fs.existsSync(statePath)) return {};
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
};

const saveState = (s: DislocationState) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
};

const weeksBetween = (startISO: string, endISO: string): number => {
  const a = new Date(startISO).getTime();
  const b = new Date(endISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (b - a) / (1000 * 60 * 60 * 24 * 7);
};

const addWeeks = (iso: string, weeks: number): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString();
};

const drawdownPct = (bars: PriceBar[], lookbackBars: number): number => {
  if (!bars.length) return 0;
  const closes = bars.slice(-lookbackBars).map((b) => b.close);
  const current = closes[closes.length - 1];
  const maxClose = Math.max(...closes);
  if (!maxClose || current === undefined) return 0;
  return (current - maxClose) / maxClose;
};

const getCloseSeries = (history?: PriceBar[]): PriceBar[] => history || [];

export const detectDislocation = (
  asOf: string,
  config: BotConfig,
  history: Record<string, PriceBar[]> | undefined,
  prices: Record<string, number>
): DislocationResult => {
  const flags: DislocationResult['flags'] = [];
  const reason: string[] = [];
  const nowISO = new Date(asOf).toISOString();
  const cfg = config.dislocation || {};
  if (!cfg.enabled) {
    return {
      asOf,
      tierEngaged: false,
      active: false,
      triggeredThisRun: false,
      reason: ['disabled'],
      metrics: { spyDrawdownFastPct: 0, spyDrawdownSlowPct: 0 },
      window: { startISO: nowISO, expiresISO: nowISO, remainingWeeks: 0 },
      flags
    };
  }
  const anchor = cfg.anchorSymbol || 'SPY';
  const series = getCloseSeries(history?.[anchor]);
  const severity = computeDislocationSeverity(series, config);
  let tier = severity.tier;
  const fast = severity.metrics.fastDrawdownPct;
  const slow = severity.metrics.slowDrawdownPct;
  const peak = severity.metrics.peakDrawdownPct || 0;

  const breadthSyms = cfg.breadthUniverseSymbols || [];
  const slowBars = cfg.slowWindowWeeks || 4;
  let breadthDown = 0;
  for (const s of breadthSyms) {
    const hh = getCloseSeries(history?.[s]);
    const dd = drawdownPct(hh, Math.min(hh.length, slowBars));
    if (dd <= -(cfg.triggerSlowDrawdownPct || 0.1)) breadthDown += 1;
  }

  const state = loadState();
  const expiresISO = state.expiresISO;
  const cooldownUntil = state.cooldownUntilISO && new Date(state.cooldownUntilISO);
  const inCooldown = cooldownUntil ? cooldownUntil > new Date(asOf) : false;

  const minTier = cfg.minActiveTier ?? 0;
  const tierEngaged = severity.tierEngaged && !inCooldown;

  let triggeredThisRun = false;
  let windowStart = state.windowStartISO || asOf;
  let windowExpires = expiresISO || asOf;
  let troughPrice = state.troughPrice;
  let troughDate = state.troughDate;

  const currentPx = prices[anchor] ?? (series.length ? series[series.length - 1].close : undefined);

  // First activation based purely on tier
  if (tierEngaged) {
    const addWeeksCfg = cfg.durationWeeksAdd ?? cfg.durationWeeks ?? 3;
    if (!state.active) triggeredThisRun = true;
    windowStart = triggeredThisRun ? asOf : state.windowStartISO || asOf;
    const defaultExpiry = addWeeks(windowStart, addWeeksCfg);
    // If previous expiry is stale, refresh it deterministically
    if (!state.expiresISO || new Date(state.expiresISO) <= new Date(asOf)) {
      windowExpires = defaultExpiry;
    } else {
      windowExpires = state.expiresISO;
    }
    if (!troughPrice) {
      troughPrice = currentPx;
      troughDate = asOf;
    }
  }

  // Recovery exit
  if (tierEngaged && cfg.recoveryPctFromLow && troughPrice && currentPx) {
    const rebound = (currentPx - troughPrice) / troughPrice;
    if (rebound >= cfg.recoveryPctFromLow) {
      // recovery exits severity engagement; lifecycle handled elsewhere
    }
  }

  // persist state
  saveState({
    active: tierEngaged,
    windowStartISO: windowStart,
    expiresISO: windowExpires,
    triggeredAtRun: triggeredThisRun ? asOf : state.triggeredAtRun,
    troughPrice,
    troughDate,
    anchorSymbol: anchor,
    cooldownUntilISO: state.cooldownUntilISO
  });

  const remainingWeeks = Math.max(0, Math.round(weeksBetween(asOf, windowExpires)));
  if (tierEngaged) {
    flags.push({
      code: triggeredThisRun ? 'DISLOCATION_TRIGGERED' : 'DISLOCATION_ACTIVE',
      severity: 'info',
      message: 'Market dislocation active',
      observed: { expiresISO: windowExpires, remainingWeeks }
    });
  }

  return {
    asOf,
    // keep legacy field name for callers expecting it
    tierEngaged,
    // deprecated alias for backward compatibility
    active: tierEngaged,
    tier: severity.tier,
    tierName: severity.tierName,
    overlayExtraExposurePct: severity.overlayExtraExposurePct,
    triggeredThisRun,
    reason,
    metrics: {
      spyDrawdownFastPct: fast,
      spyDrawdownSlowPct: slow,
      peakDrawdownPct: peak,
      breadthConfirm: cfg.confirmBreadth ? { symbolsChecked: breadthSyms, downCount: breadthDown } : undefined,
      troughDate,
      troughPrice,
      anchorPrice: currentPx
    },
    window: { startISO: windowStart, expiresISO: windowExpires, remainingWeeks },
    flags
  };
};
