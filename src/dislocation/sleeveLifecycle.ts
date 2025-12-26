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

  // New trigger
  if (!state.active && dislocationActive) {
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
    state.active = false;
    state.cooldownUntilISO = addWeeks(now, cfg.cooldownWeeks ?? 0);
  }

  if (earlyExitEnabled && (deepFailsafe || (riskOff && riskConf >= riskOffThreshold))) {
    state.phase = 'REINTEGRATE';
    state.active = false;
    state.cooldownUntilISO = addWeeks(now, cfg.cooldownWeeks ?? 0);
    flags.push({
      code: deepFailsafe ? 'DISLOCATION_FAILSAFE_TRIGGERED' : 'DISLOCATION_EARLY_EXIT_RISK_OFF',
      severity: 'warn',
      message: 'Dislocation sleeve early exit',
      observed: { riskOff, riskConf, anchorPrice, entryAnchorPrice: state.entryAnchorPrice }
    });
  }

  // Save state
  saveSleeveState(state);

  const allowAdd = state.phase === 'ADD';
  const protectFromSells = state.phase === 'ADD' || state.phase === 'HOLD';
  const allowReintegration = state.phase === 'REINTEGRATE';

  return { state, allowAdd, protectFromSells, allowReintegration, flags };
};
