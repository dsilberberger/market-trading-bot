import { RegimeContext } from '../core/types';

export type SleeveType = 'dislocation' | 'insurance' | 'growthConvexity';

export interface SleeveArbitrationInput {
  regimes?: RegimeContext;
  dislocationActive?: boolean;
}

export interface SleeveArbitrationResult {
  allowed: Record<SleeveType, boolean>;
  reasons: string[];
}

export const arbitrateSleeves = (input: SleeveArbitrationInput): SleeveArbitrationResult => {
  const reasons: string[] = [];
  const { regimes, dislocationActive } = input;
  const equity = regimes?.equityRegime;
  const vol = regimes?.volRegime;
  const severeStress = equity?.label === 'risk_off' || vol?.label === 'stressed';
  const robust =
    equity?.label === 'risk_on' &&
    (equity?.confidence ?? 0) >= 0.6 &&
    vol?.label !== 'stressed';

  let insurance = false;
  let growth = false;

  if (severeStress || dislocationActive) {
    insurance = true;
    reasons.push('Insurance allowed: severe stress or dislocation');
  }

  if (!dislocationActive && robust) {
    growth = true;
    reasons.push('Growth convexity allowed: robust regime and no dislocation');
  } else if (dislocationActive) {
    reasons.push('Growth convexity disabled: dislocation active');
  } else if (!robust) {
    reasons.push('Growth convexity disabled: regime not robust');
  }

  // Mutual exclusivity with priority to insurance
  if (insurance && growth) {
    growth = false;
    reasons.push('Growth convexity disabled due to insurance priority');
  }

  const allowed: Record<SleeveType, boolean> = {
    dislocation: true,
    insurance,
    growthConvexity: growth
  };

  return { allowed, reasons };
};
