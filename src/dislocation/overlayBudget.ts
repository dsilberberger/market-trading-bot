import { BotConfig } from '../core/types';

export const getAllowedExposurePct = ({
  phase,
  baseExposureCapPct,
  maxTotalExposureCapPct,
  handoffExtraExposurePct = 0
}: {
  phase?: string;
  baseExposureCapPct: number;
  maxTotalExposureCapPct: number;
  handoffExtraExposurePct?: number;
}) => {
  if (phase === 'ADD' || phase === 'HOLD') return maxTotalExposureCapPct;
  if (handoffExtraExposurePct > 0) {
    return Math.min(1, Math.max(baseExposureCapPct, Math.min(maxTotalExposureCapPct, baseExposureCapPct + handoffExtraExposurePct)));
  }
  return baseExposureCapPct;
};

const resolveHandoffExtraExposurePct = ({
  asOf,
  handoffStartedAtISO,
  handoffEndsAtISO,
  handoffBaseExtraExposurePct
}: {
  asOf?: string;
  handoffStartedAtISO?: string;
  handoffEndsAtISO?: string;
  handoffBaseExtraExposurePct?: number;
}) => {
  if (!asOf || !handoffStartedAtISO || !handoffEndsAtISO || !handoffBaseExtraExposurePct || handoffBaseExtraExposurePct <= 0) {
    return 0;
  }
  const now = new Date(asOf).getTime();
  const start = new Date(handoffStartedAtISO).getTime();
  const end = new Date(handoffEndsAtISO).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || now >= end) return 0;
  if (now <= start) return handoffBaseExtraExposurePct;
  const remaining = 1 - (now - start) / (end - start);
  return Math.max(0, handoffBaseExtraExposurePct * remaining);
};

export interface OverlayBudgetInput {
  asOf?: string;
  equityUSD: number;
  cashUSD: number;
  minCashUSD: number;
  overlayExtraExposurePct: number;
  maxTotalExposureCapPct: number;
  currentInvestedUSD: number;
  cheapestOverlayPrice?: number;
  overlayMinBudgetUSD?: number;
  overlayMinBudgetPolicy?: 'gate' | 'warn';
  phase?: string;
  baseExposureCapPct?: number;
  allowAdd?: boolean;
  dislocationActive?: boolean;
  pacingDeployPct?: number;
  handoffStartedAtISO?: string;
  handoffEndsAtISO?: string;
  handoffBaseExtraExposurePct?: number;
}

export interface OverlayBudgetResult {
  overlayBudgetUSD: number;
  availableCashUSD: number;
  remainingInvestCapacityUSD: number;
  source?: 'add_phase' | 'handoff_decay' | 'disabled';
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

export const computeOverlayBudget = ({
  asOf,
  equityUSD,
  cashUSD,
  minCashUSD,
  overlayExtraExposurePct,
  maxTotalExposureCapPct,
  currentInvestedUSD,
  cheapestOverlayPrice,
  overlayMinBudgetUSD,
  overlayMinBudgetPolicy = 'gate',
  phase,
  baseExposureCapPct = 0,
  allowAdd = true,
  dislocationActive = true,
  pacingDeployPct = 1,
  handoffStartedAtISO,
  handoffEndsAtISO,
  handoffBaseExtraExposurePct
}: OverlayBudgetInput): OverlayBudgetResult => {
  const flags: OverlayBudgetResult['flags'] = [];
  const isAddPhase = phase === 'ADD' && allowAdd === true && dislocationActive === true;
  const handoffExtraExposurePct = isAddPhase
    ? 0
    : resolveHandoffExtraExposurePct({ asOf, handoffStartedAtISO, handoffEndsAtISO, handoffBaseExtraExposurePct });
  const handoffActive = handoffExtraExposurePct > 0;
  const availableCashUSD = Math.max(0, cashUSD - minCashUSD);

  // If not in ADD phase and no handoff decay is active, disable overlay entirely and log why.
  if (!isAddPhase && !handoffActive) {
    const effectivePct = baseExposureCapPct;
    const effectiveAllowedInvestedUSD = Math.max(0, effectivePct * equityUSD);
    const remainingInvestCapacityUSD = Math.max(0, effectiveAllowedInvestedUSD - currentInvestedUSD);
    flags.push({
      code: 'OVERLAY_DISABLED_NOT_IN_ADD_PHASE',
      severity: 'info',
      message: 'Overlay disabled outside ADD phase',
      observed: {
        phase,
        effectiveExposurePct: effectivePct,
        effectiveAllowedInvestedUSD,
        remainingInvestCapacityUSD
      }
    });
    flags.push({
      code: 'OVERLAY_BUDGET_COMPUTED',
      severity: 'info',
      message: 'Overlay budget computed',
      observed: {
        overlayBudgetUSD: 0,
        overlayNominalBudget: 0,
        remainingInvestCapacityUSD,
        availableCashUSD,
        effectiveExposurePct: effectivePct,
        effectiveAllowedInvestedUSD
      }
    });
    return { overlayBudgetUSD: 0, availableCashUSD, remainingInvestCapacityUSD, source: 'disabled', flags };
  }

  if (availableCashUSD <= 0) {
    flags.push({
      code: 'OVERLAY_NO_CASH_AVAILABLE',
      severity: 'info',
      message: 'No cash available for overlay after min cash buffer',
      observed: { cashUSD, minCashUSD }
    });
  }

  const overlayNominalBudget = Math.max(0, (isAddPhase ? overlayExtraExposurePct : handoffExtraExposurePct) * equityUSD);
  const effectivePct = getAllowedExposurePct({
    phase: isAddPhase ? phase : undefined,
    baseExposureCapPct,
    maxTotalExposureCapPct,
    handoffExtraExposurePct
  });
  const totalAllowedInvestedUSD = Math.max(0, effectivePct * equityUSD);
  const remainingInvestCapacityUSD = Math.max(0, totalAllowedInvestedUSD - currentInvestedUSD);

  let overlayBudgetUSD = Math.min(overlayNominalBudget, remainingInvestCapacityUSD, availableCashUSD);
  if (isAddPhase && pacingDeployPct < 1) {
    overlayBudgetUSD = Math.min(overlayBudgetUSD, overlayNominalBudget * pacingDeployPct);
  }
  if (overlayBudgetUSD <= 0) {
    flags.push({
      code: 'OVERLAY_CAP_LIMIT',
      severity: 'info',
      message: 'Overlay limited by exposure cap or cash',
      observed: { remainingInvestCapacityUSD, availableCashUSD, overlayNominalBudget }
    });
  }
  if (handoffActive) {
    flags.push({
      code: 'OVERLAY_HANDOFF_ACTIVE',
      severity: 'info',
      message: 'Dislocation overlay handoff decay is active',
      observed: {
        handoffStartedAtISO,
        handoffEndsAtISO,
        handoffExtraExposurePct,
        baseExposureCapPct,
        effectiveExposurePct: effectivePct
      }
    });
  }

  const belowMin = overlayBudgetUSD > 0 && overlayMinBudgetUSD && overlayBudgetUSD < overlayMinBudgetUSD;
  if (belowMin) {
    if (overlayMinBudgetPolicy === 'gate') {
      flags.push({
        code: 'OVERLAY_SKIPPED_MIN_BUDGET',
        severity: 'info',
        message: 'Overlay budget below configured minimum; skipping overlay',
        observed: { overlayBudgetUSD, overlayMinBudgetUSD }
      });
      overlayBudgetUSD = 0;
    } else {
      flags.push({
        code: 'OVERLAY_BELOW_MIN_BUDGET',
        severity: 'info',
        message: 'Overlay budget below configured minimum',
        observed: { overlayBudgetUSD, overlayMinBudgetUSD }
      });
    }
  }

  if (cheapestOverlayPrice !== undefined && overlayBudgetUSD > 0 && overlayBudgetUSD < cheapestOverlayPrice) {
    overlayBudgetUSD = 0;
    flags.push({
      code: 'OVERLAY_UNDER_MIN_LOT',
      severity: 'info',
      message: 'Overlay budget below minimum lot cost',
      observed: { cheapestOverlayPrice }
    });
  }

  flags.push({
    code: 'OVERLAY_BUDGET_COMPUTED',
    severity: 'info',
    message: 'Overlay budget computed',
      observed: {
        overlayBudgetUSD,
        overlayNominalBudget,
        remainingInvestCapacityUSD,
        availableCashUSD,
        source: handoffActive ? 'handoff_decay' : 'add_phase',
        effectiveExposurePct: effectivePct,
        effectiveAllowedInvestedUSD: effectivePct * equityUSD
      }
    });

  return {
    overlayBudgetUSD,
    availableCashUSD,
    remainingInvestCapacityUSD,
    source: handoffActive ? 'handoff_decay' : 'add_phase',
    flags
  };
};
