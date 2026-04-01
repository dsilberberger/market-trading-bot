import { BotConfig, PriceBar } from '../core/types';
import { DislocationSleeveState, SleevePhase, loadSleeveState, saveSleeveState } from './sleeveState';
import { evaluatePostRiskOffStabilization } from './postRiskOffReentry';

type HandoffSleeveState = DislocationSleeveState & {
  handoffStartedAtISO?: string;
  handoffEndsAtISO?: string;
  handoffBaseExtraExposurePct?: number;
};

const HANDOFF_DECAY_WEEKS = 3;
const HANDOFF_CARRY_FRACTION = 0.25;

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
  anchorHistory?: PriceBar[];
  regimes?: any;
  tier?: number;
}

export interface SleeveLifecycleResult {
  state: HandoffSleeveState;
  allowAdd: boolean;
  protectFromSells: boolean;
  allowReintegration: boolean;
  tierEngaged: boolean;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

export const deriveLifecycleBooleans = (phase: SleevePhase | undefined, engaged = false) => {
  switch (phase) {
    case 'ADD':
      return { active: true, allowAdd: !!engaged, protectFromSells: true, allowReintegration: false };
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
  anchorHistory = [],
  regimes,
  tier = 0
}: SleeveLifecycleInput): SleeveLifecycleResult => {
  const flags: SleeveLifecycleResult['flags'] = [];
  const cfg = config.dislocation || {};
  let state = loadSleeveState() as HandoffSleeveState;
  const phaseBeforeStep = state.phase;
  const now = nowIso(asOf);
  const minWeeksBetweenTier = cfg.minWeeksBetweenTierChanges ?? 0;
  const hysteresis = cfg.tierHysteresisPct ?? 0;
  const minActiveTier = cfg.minActiveTier ?? 0;
  let requestedTier = tier || 0;
  if (dislocationActive && requestedTier < minActiveTier) requestedTier = minActiveTier;

  // Early exit: risk_off with high confidence
  const riskOff = regimes?.equityRegime?.label === 'risk_off';
  const riskOn = regimes?.equityRegime?.label === 'risk_on';
  const riskConf = regimes?.equityRegime?.confidence ?? 0;
  const earlyExitEnabled = cfg.earlyExit?.enabled !== false;
  const riskOffThreshold = cfg.earlyExit?.riskOffConfidenceThreshold ?? 0.7;
  const earlyReentryEnabled = cfg.earlyReentry?.enabled !== false;

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

  if (earlyReentryEnabled && riskOff && !state.postRiskOffEpisodeStartISO) {
    state.postRiskOffEpisodeStartISO = now;
    state.postRiskOffTriggeredAtISO = undefined;
    state.postRiskOffTriggerCount = 0;
  }
  if (earlyReentryEnabled && riskOn && state.phase === 'INACTIVE') {
    state.postRiskOffEpisodeStartISO = undefined;
    state.postRiskOffTriggeredAtISO = undefined;
    state.postRiskOffTriggerCount = 0;
  }
  // Recompute phase from dates if state exists
  if (state.triggeredAtISO && state.addUntilISO && state.holdUntilISO) {
    const nowDate = new Date(now);
    if (nowDate <= new Date(state.addUntilISO)) state.phase = 'ADD';
    else if (nowDate <= new Date(state.holdUntilISO)) state.phase = 'HOLD';
    else state.phase = 'REINTEGRATE';
  }
  if (state.handoffEndsAtISO && new Date(now) >= new Date(state.handoffEndsAtISO)) {
    state.handoffStartedAtISO = undefined;
    state.handoffEndsAtISO = undefined;
    state.handoffBaseExtraExposurePct = undefined;
  }

  // tier management with hysteresis and cadence
  const prevTier = state.currentTier ?? 0;
  let currentTier = requestedTier;
  if (currentTier < prevTier && hysteresis > 0) {
    const tierCfg = (cfg.tiers || []).find((t) => t.tier === prevTier);
    const boundary = tierCfg?.peakDrawdownGte ?? 0;
    if (tier < prevTier && tier > 0 && tier > boundary - hysteresis) {
      currentTier = prevTier;
    }
  }
  if (prevTier !== currentTier) {
    const weeksSinceChange = state.lastTierChangeISO ? (new Date(now).getTime() - new Date(state.lastTierChangeISO).getTime()) / (1000 * 60 * 60 * 24 * 7) : Infinity;
    if (weeksSinceChange < minWeeksBetweenTier) currentTier = prevTier;
    else {
      state.lastTier = prevTier;
      state.lastTierChangeISO = now;
    }
  }
  state.currentTier = currentTier;

  const engaged = isDislocationActive(currentTier, minActiveTier);
  const postRiskOffReentry =
    earlyReentryEnabled && state.postRiskOffEpisodeStartISO && !state.postRiskOffTriggeredAtISO
      ? evaluatePostRiskOffStabilization({
          bars: anchorHistory || [],
          episodeStartISO: state.postRiskOffEpisodeStartISO,
          config
        })
      : null;

  const canActivateFromInactive = !state.phase || state.phase === 'INACTIVE';
  const canReactivateFromReintegrate = state.phase === 'REINTEGRATE' && !!postRiskOffReentry?.eligible;

  // New trigger allowed from INACTIVE, and post-risk-off re-entry may restart from REINTEGRATE.
  if ((canActivateFromInactive || canReactivateFromReintegrate) && (engaged || postRiskOffReentry?.eligible)) {
    const addWeeksCfg = cfg.durationWeeksAdd ?? 3;
    const holdWeeksCfg = cfg.durationWeeksHold ?? 10;
    state.triggeredAtISO = now;
    state.addUntilISO = addWeeks(state.triggeredAtISO, addWeeksCfg);
    state.holdUntilISO = addWeeks(state.triggeredAtISO, addWeeksCfg + holdWeeksCfg);
    state.reintegrateAfterISO = state.holdUntilISO;
    state.phase = 'ADD';
    state.triggerReason = postRiskOffReentry?.eligible ? 'post_risk_off_reentry' : 'dislocation';
    state.handoffStartedAtISO = undefined;
    state.handoffEndsAtISO = undefined;
    state.handoffBaseExtraExposurePct = undefined;
    state.entryAnchorPrice = state.entryAnchorPrice ?? anchorPrice;
    if (!state.troughAnchorPrice || (anchorPrice && anchorPrice < state.troughAnchorPrice)) {
      state.troughAnchorPrice = anchorPrice;
      state.troughDateISO = now;
    }
    state.active = true;
    if (postRiskOffReentry?.eligible) {
      state.postRiskOffTriggeredAtISO = now;
      state.postRiskOffTriggerCount = (state.postRiskOffTriggerCount ?? 0) + 1;
      flags.push({
        code: 'POST_RISK_OFF_REENTRY_TRIGGERED',
        severity: 'info',
        message: 'Post-risk-off dislocation sleeve trigger fired',
        observed: postRiskOffReentry.diagnostics
      });
    } else {
      flags.push({ code: 'DISLOCATION_SLEEVE_TRIGGERED', severity: 'info', message: 'Dislocation sleeve triggered' });
    }
  }

  // Phase transitions
  if (state.phase === 'ADD' && state.addUntilISO && new Date(now) > new Date(state.addUntilISO)) {
    state.phase = 'HOLD';
  }
  if (state.phase === 'HOLD' && state.holdUntilISO && new Date(now) > new Date(state.holdUntilISO)) {
    state.phase = 'REINTEGRATE';
  }
  // Once in REINTEGRATE, ignore future triggers until returning to INACTIVE
  if (state.phase === 'REINTEGRATE' && engaged) {
    flags.push({
      code: 'DISLOCATION_TRIGGER_IGNORED_DURING_REINTEGRATE',
      severity: 'info',
      message: 'Trigger ignored during reintegrate phase',
      observed: { tier: currentTier }
    });
  }
  if (postRiskOffReentry?.eligible && state.phase === 'REINTEGRATE') {
    flags.push({
      code: 'POST_RISK_OFF_REENTRY_IGNORED_DURING_REINTEGRATE',
      severity: 'info',
      message: 'Post-risk-off re-entry ignored during reintegrate phase',
      observed: postRiskOffReentry.diagnostics
    });
  }

  const sleeveActiveForExit = state.phase === 'ADD' || state.phase === 'HOLD';
  const justActivatedThisStep = phaseBeforeStep !== state.phase && state.phase === 'ADD';
  if (
    earlyExitEnabled &&
    sleeveActiveForExit &&
    !justActivatedThisStep &&
    (deepFailsafe || (riskOff && riskConf >= riskOffThreshold))
  ) {
    state.phase = 'REINTEGRATE';
    state.cooldownUntilISO = addWeeks(now, cfg.cooldownWeeks ?? 0);
    flags.push({
      code: deepFailsafe ? 'DISLOCATION_FAILSAFE_TRIGGERED' : 'DISLOCATION_EARLY_EXIT_RISK_OFF',
      severity: 'warn',
      message: 'Dislocation sleeve early exit',
      observed: { riskOff, riskConf, anchorPrice, entryAnchorPrice: state.entryAnchorPrice }
    });
  }
  if (phaseBeforeStep === 'ADD' && state.phase !== 'ADD' && !riskOff && !deepFailsafe) {
    const tierCfg = (cfg.tiers || []).find((t) => t.tier === currentTier);
    const overlayExtraExposurePct =
      tierCfg?.overlayExtraExposurePct ?? cfg.overlayExtraExposurePct ?? cfg.opportunisticExtraExposurePct ?? 0;
    const handoffBaseExtraExposurePct = Math.max(0, overlayExtraExposurePct * HANDOFF_CARRY_FRACTION);
    if (handoffBaseExtraExposurePct > 0) {
      state.handoffStartedAtISO = now;
      state.handoffEndsAtISO = addWeeks(now, HANDOFF_DECAY_WEEKS);
      state.handoffBaseExtraExposurePct = handoffBaseExtraExposurePct;
      flags.push({
        code: 'DISLOCATION_HANDOFF_STARTED',
        severity: 'info',
        message: 'Dislocation overlay handoff decay started',
        observed: {
          fromPhase: phaseBeforeStep,
          toPhase: state.phase,
          handoffStartedAtISO: state.handoffStartedAtISO,
          handoffEndsAtISO: state.handoffEndsAtISO,
          handoffBaseExtraExposurePct
        }
      });
    }
  }

  // Derive active/controls from phase
  const addEngaged =
    (engaged && state.phase === 'ADD') ||
    (state.phase === 'ADD' && state.triggerReason === 'post_risk_off_reentry');
  const derived = deriveLifecycleBooleans(state.phase, addEngaged);
  state.active = derived.active;
  const { allowAdd, protectFromSells, allowReintegration } = derived;
  if (currentTier === 0 && allowAdd && state.triggerReason !== 'post_risk_off_reentry') {
    flags.push({
      code: 'DISLOCATION_IGNORED_TIER0_ADD_ATTEMPT',
      severity: 'error',
      message: 'Tier 0 cannot allow ADD buys',
      observed: { phase: state.phase }
    });
  }

  // Invariant check (warn; in tests we can assert)
  const invariantOk =
    (state.phase === 'ADD' && protectFromSells && state.active) ||
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

  return { state, allowAdd, protectFromSells, allowReintegration, tierEngaged: engaged, flags };
};
const isDislocationActive = (tier: number, minActiveTier: number) => tier >= minActiveTier;
