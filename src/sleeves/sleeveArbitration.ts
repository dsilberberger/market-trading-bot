import { BotConfig, RegimeContext } from '../core/types';

export type SleeveType = 'dislocation' | 'insurance' | 'growthConvexity';

export interface SleeveArbitrationInput {
  regimes?: RegimeContext;
  dislocationActive?: boolean;
  config?: BotConfig;
}

export interface SleeveArbitrationResult {
  allowed: Record<SleeveType, boolean>;
  reasons: string[];
}

export const arbitrateSleeves = (input: SleeveArbitrationInput): SleeveArbitrationResult => {
  const reasons: string[] = [];
  const { regimes, dislocationActive, config } = input;
  const equity = regimes?.equityRegime;
  const vol = regimes?.volRegime;
  const severeStress = equity?.label === 'risk_off' || vol?.label === 'stressed';
  const timeInRegimeWeeks = equity?.supports?.timeInRegimeWeeks ?? 0;
  const confidence = equity?.confidence ?? 0;
  const growthConfidenceMin = config?.growth?.confidenceMin ?? 0.6;
  const growthMinTimeInRegimeWeeks = config?.growth?.minTimeInRegimeWeeks ?? 2;
  const robust =
    equity?.label === 'risk_on' &&
    confidence >= growthConfidenceMin &&
    timeInRegimeWeeks >= growthMinTimeInRegimeWeeks &&
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
    if (equity?.label !== 'risk_on') reasons.push('Growth convexity disabled: equity regime not risk_on');
    else if (confidence < growthConfidenceMin)
      reasons.push(`Growth convexity disabled: confidence below ${growthConfidenceMin}`);
    else if (timeInRegimeWeeks < growthMinTimeInRegimeWeeks)
      reasons.push(`Growth convexity disabled: time in regime < ${growthMinTimeInRegimeWeeks} weeks`);
    else if (vol?.label === 'stressed') reasons.push('Growth convexity disabled: vol stressed');
    else reasons.push('Growth convexity disabled: regime not robust');
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
