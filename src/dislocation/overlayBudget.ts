import { BotConfig } from '../core/types';

export const getAllowedExposurePct = ({
  phase,
  baseExposureCapPct,
  maxTotalExposureCapPct
}: {
  phase?: string;
  baseExposureCapPct: number;
  maxTotalExposureCapPct: number;
}) => {
  if (phase === 'ADD' || phase === 'HOLD') return maxTotalExposureCapPct;
  return baseExposureCapPct;
};

export interface OverlayBudgetInput {
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
}

export interface OverlayBudgetResult {
  overlayBudgetUSD: number;
  availableCashUSD: number;
  remainingInvestCapacityUSD: number;
  flags: Array<{ code: string; severity: 'info' | 'warn' | 'error'; message: string; observed?: any }>;
}

export const computeOverlayBudget = ({
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
  dislocationActive = true
}: OverlayBudgetInput): OverlayBudgetResult => {
  const flags: OverlayBudgetResult['flags'] = [];
  const isAddPhase = phase === 'ADD' && allowAdd === true && dislocationActive === true;
  const availableCashUSD = Math.max(0, cashUSD - minCashUSD);

  // If not in ADD phase, disable overlay entirely and log why for clean diagnostics.
  if (!isAddPhase) {
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
    return { overlayBudgetUSD: 0, availableCashUSD, remainingInvestCapacityUSD, flags };
  }

  if (availableCashUSD <= 0) {
    flags.push({
      code: 'OVERLAY_NO_CASH_AVAILABLE',
      severity: 'info',
      message: 'No cash available for overlay after min cash buffer',
      observed: { cashUSD, minCashUSD }
    });
  }

  const overlayNominalBudget = Math.max(0, overlayExtraExposurePct * equityUSD);
  const effectivePct = getAllowedExposurePct({ phase, baseExposureCapPct, maxTotalExposureCapPct });
  const totalAllowedInvestedUSD = Math.max(0, effectivePct * equityUSD);
  const remainingInvestCapacityUSD = Math.max(0, totalAllowedInvestedUSD - currentInvestedUSD);

  let overlayBudgetUSD = Math.min(overlayNominalBudget, remainingInvestCapacityUSD, availableCashUSD);
  if (overlayBudgetUSD <= 0) {
    flags.push({
      code: 'OVERLAY_CAP_LIMIT',
      severity: 'info',
      message: 'Overlay limited by exposure cap or cash',
      observed: { remainingInvestCapacityUSD, availableCashUSD, overlayNominalBudget }
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
      effectiveExposurePct: effectivePct,
      effectiveAllowedInvestedUSD: effectivePct * equityUSD
    }
  });

  return { overlayBudgetUSD, availableCashUSD, remainingInvestCapacityUSD, flags };
};
