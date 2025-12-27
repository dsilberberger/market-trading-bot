import { BotConfig } from '../core/types';
import { DislocationSleeveState, SleevePhase, loadSleeveState, saveSleeveState } from './sleeveState';

const addWeeks = (iso: string, weeks: number): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString();
};

const nowIso = (asOf: string) => new Date(asOf).toISOString();

export interface SleeveLifecycleInput {
  asOf: string;
  config: BotConfig;
  dislocationActive: boolean;
  anchorPrice?: number;
  regimes?: any;
}

export interface SleeveLifecycleResult {
  state: DislocationSleeveState;
  allowAdd: boolean;
  protectFromSells: boolean;
  allowReintegration: boolean;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

export const deriveLifecycleBooleans = (phase: SleevePhase | undefined) => {
  switch (phase) {
    case 'ADD':
      return { active: true, allowAdd: true, protectFromSells: true, allowReintegration: false };
    case 'HOLD':
      return { active: true, allowAdd: false, protectFromSells: true, allowReintegration: false };
    case 'REINTEGRATE':
      return { active: false, allowAdd: false, protectFromSells: false, allowReintegration: true };
    default:
      return { active: false, allowAdd: false, protectFromSells: false, allowReintegration: false };
  }
};

export const runSleeveLifecycle = ({
  asOf,
  config,
  dislocationActive,
  anchorPrice,
  regimes
}: SleeveLifecycleInput): SleeveLifecycleResult => {
  const flags: SleeveLifecycleResult['flags'] = [];
  const cfg = config.dislocation || {};
  let state = loadSleeveState();
  const now = nowIso(asOf);

  // Early exit: risk_off with high confidence
  const riskOff = regimes?.equityRegime?.label === 'risk_off';
  const riskConf = regimes?.equityRegime?.confidence ?? 0;
  const earlyExitEnabled = cfg.earlyExit?.enabled !== false;
  const riskOffThreshold = cfg.earlyExit?.riskOffConfidenceThreshold ?? 0.7;

  // Deep drawdown failsafe
  const deepFailsafePct = cfg.earlyExit?.deepDrawdownFailsafePct ?? 0.3;
  const deepFailsafe =
    earlyExitEnabled &&
    state.entryAnchorPrice &&
    anchorPrice &&
    anchorPrice <= state.entryAnchorPrice * (1 - deepFailsafePct);

  // If state has triggered but missing windows, recompute
  if (state.triggeredAtISO) {
    const addWeeksCfg = cfg.durationWeeksAdd ?? 3;
    const holdWeeksCfg = cfg.durationWeeksHold ?? 10;
    if (!state.addUntilISO) state.addUntilISO = addWeeks(state.triggeredAtISO, addWeeksCfg);
    if (!state.holdUntilISO) state.holdUntilISO = addWeeks(state.triggeredAtISO, addWeeksCfg + holdWeeksCfg);
    if (!state.reintegrateAfterISO) state.reintegrateAfterISO = state.holdUntilISO;
  }
  // Recompute phase from dates if state exists
  if (state.triggeredAtISO && state.addUntilISO && state.holdUntilISO) {
    const nowDate = new Date(now);
    if (nowDate <= new Date(state.addUntilISO)) state.phase = 'ADD';
    else if (nowDate <= new Date(state.holdUntilISO)) state.phase = 'HOLD';
    else state.phase = 'REINTEGRATE';
  }

  // New trigger
  if ((!state.active || state.phase === 'INACTIVE' || !state.phase) && dislocationActive) {
    const addWeeksCfg = cfg.durationWeeksAdd ?? 3;
    const holdWeeksCfg = cfg.durationWeeksHold ?? 10;
    state = {
      active: true,
      phase: 'ADD',
      triggeredAtISO: now,
      addUntilISO: addWeeks(now, addWeeksCfg),
      holdUntilISO: addWeeks(now, addWeeksCfg + holdWeeksCfg),
      reintegrateAfterISO: addWeeks(now, addWeeksCfg + holdWeeksCfg),
      entryAnchorPrice: anchorPrice,
      troughAnchorPrice: anchorPrice,
      troughDateISO: now
    };
    flags.push({ code: 'DISLOCATION_SLEEVE_TRIGGERED', severity: 'info', message: 'Dislocation sleeve triggered' });
  }

  // Phase transitions
  if (state.phase === 'ADD' && state.addUntilISO && new Date(now) > new Date(state.addUntilISO)) {
    state.phase = 'HOLD';
  }
  if (state.phase === 'HOLD' && state.holdUntilISO && new Date(now) > new Date(state.holdUntilISO)) {
    state.phase = 'REINTEGRATE';
  }

  if (earlyExitEnabled && (deepFailsafe || (riskOff && riskConf >= riskOffThreshold))) {
    state.phase = 'REINTEGRATE';
    state.cooldownUntilISO = addWeeks(now, cfg.cooldownWeeks ?? 0);
    flags.push({
      code: deepFailsafe ? 'DISLOCATION_FAILSAFE_TRIGGERED' : 'DISLOCATION_EARLY_EXIT_RISK_OFF',
      severity: 'warn',
      message: 'Dislocation sleeve early exit',
      observed: { riskOff, riskConf, anchorPrice, entryAnchorPrice: state.entryAnchorPrice }
    });
  }

  // Derive active/controls from phase
  const derived = deriveLifecycleBooleans(state.phase);
  state.active = derived.active;
  const { allowAdd, protectFromSells, allowReintegration } = derived;

  // Invariant check (warn; in tests we can assert)
  const invariantOk =
    (state.phase === 'ADD' && allowAdd && protectFromSells && state.active) ||
    (state.phase === 'HOLD' && !allowAdd && protectFromSells && state.active) ||
    (state.phase === 'REINTEGRATE' && !allowAdd && !protectFromSells) ||
    (!state.phase && !allowAdd && !protectFromSells);
  if (!invariantOk) {
    flags.push({
      code: 'DISLOCATION_STATE_INVARIANT',
      severity: 'warn',
      message: 'Lifecycle invariant violated; derived controls used',
      observed: { phase: state.phase, allowAdd, protectFromSells, active: state.active }
    });
  }

  // Save state
  saveSleeveState(state);

  return { state, allowAdd, protectFromSells, allowReintegration, flags };
};
