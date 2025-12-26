import fs from 'fs';
import path from 'path';
import { BotConfig, PriceBar } from '../core/types';

export interface DislocationResult {
  asOf: string;
  active: boolean;
  triggeredThisRun: boolean;
  reason: string[];
  metrics: {
    spyDrawdownFastPct: number;
    spyDrawdownSlowPct: number;
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
      active: false,
      triggeredThisRun: false,
      reason: ['disabled'],
      metrics: { spyDrawdownFastPct: 0, spyDrawdownSlowPct: 0 },
      window: { startISO: nowISO, expiresISO: nowISO, remainingWeeks: 0 },
      flags
    };
  }
  const anchor = cfg.anchorSymbol || 'SPY';
  const fastBars = Math.max(1, Math.round((cfg.lookbackDaysFast || 5) / 5)); // weekly approx
  const slowBars = Math.max(1, Math.round((cfg.lookbackDaysSlow || 20) / 5)); // weekly approx
  const series = getCloseSeries(history?.[anchor]);
  const fast = drawdownPct(series, Math.min(series.length, fastBars));
  const slow = drawdownPct(series, Math.min(series.length, slowBars));

  const breadthSyms = cfg.breadthUniverseSymbols || [];
  let breadthDown = 0;
  for (const s of breadthSyms) {
    const hh = getCloseSeries(history?.[s]);
    const dd = drawdownPct(hh, Math.min(hh.length, slowBars));
    if (dd <= -(cfg.triggerSlowDrawdownPct || 0.1)) breadthDown += 1;
  }

  const state = loadState();
  const expiresISO = state.expiresISO;
  let active = Boolean(state.active) && expiresISO ? new Date(expiresISO) > new Date(asOf) : false;
  const cooldownUntil = state.cooldownUntilISO && new Date(state.cooldownUntilISO);
  const inCooldown = cooldownUntil ? cooldownUntil > new Date(asOf) : false;

  const triggerFast = fast <= -(cfg.triggerFastDrawdownPct || 0.05);
  const triggerSlow = slow <= -(cfg.triggerSlowDrawdownPct || 0.1);
  const breadthOk = cfg.confirmBreadth ? breadthDown >= (cfg.breadthMinDownCount || 1) : true;

  let triggeredThisRun = false;
  let windowStart = state.windowStartISO || asOf;
  let windowExpires = expiresISO || asOf;
  let troughPrice = state.troughPrice;
  let troughDate = state.troughDate;

  // Recovery exit
  const currentPx = prices[anchor] ?? (series.length ? series[series.length - 1].close : undefined);
  if (active && cfg.recoveryPctFromLow && troughPrice && currentPx) {
    const rebound = (currentPx - troughPrice) / troughPrice;
    if (rebound >= cfg.recoveryPctFromLow) {
      active = false;
    }
  }
  if (active && expiresISO && new Date(expiresISO) <= new Date(asOf)) {
    active = false;
  }

  if (!active && !inCooldown && (triggerFast || triggerSlow) && breadthOk) {
    active = true;
    triggeredThisRun = true;
    windowStart = asOf;
    windowExpires = addWeeks(asOf, cfg.durationWeeks || 3);
    troughPrice = currentPx;
    troughDate = asOf;
    reason.push(triggerFast ? 'fast_drawdown' : 'slow_drawdown');
    if (cfg.confirmBreadth) reason.push('breadth_confirmed');
    const cdUntil = addWeeks(windowExpires, cfg.cooldownWeeks || 0);
    saveState({
      active,
      windowStartISO: windowStart,
      expiresISO: windowExpires,
      triggeredAtRun: asOf,
      troughPrice,
      troughDate,
      anchorSymbol: anchor,
      cooldownUntilISO: cdUntil
    });
  } else {
    // persist any changes
    saveState({
      active,
      windowStartISO: windowStart,
      expiresISO: windowExpires,
      triggeredAtRun: state.triggeredAtRun,
      troughPrice,
      troughDate,
      anchorSymbol: anchor,
      cooldownUntilISO: state.cooldownUntilISO
    });
  }

  const remainingWeeks = Math.max(0, Math.round(weeksBetween(asOf, windowExpires)));
  if (active) {
    flags.push({
      code: triggeredThisRun ? 'DISLOCATION_TRIGGERED' : 'DISLOCATION_ACTIVE',
      severity: 'info',
      message: 'Market dislocation active',
      observed: { expiresISO: windowExpires, remainingWeeks }
    });
  }

  return {
    asOf,
    active,
    triggeredThisRun,
    reason,
    metrics: {
      spyDrawdownFastPct: fast,
      spyDrawdownSlowPct: slow,
      breadthConfirm: cfg.confirmBreadth ? { symbolsChecked: breadthSyms, downCount: breadthDown } : undefined,
      troughDate,
      troughPrice,
      anchorPrice: currentPx
    },
    window: { startISO: windowStart, expiresISO: windowExpires, remainingWeeks },
    flags
  };
};
