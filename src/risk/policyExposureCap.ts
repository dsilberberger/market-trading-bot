type EquityRegimeLabel = 'risk_on' | 'risk_off' | 'neutral' | 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL' | undefined;
type VolRegimeLabel = 'low' | 'rising' | 'stressed' | undefined;
type TransitionRisk = 'low' | 'elevated' | 'high' | undefined;
type CoarsePercentilesMode = 'hard_cap' | 'conditioned_risk_on' | undefined;

export interface CoarsePercentilesPolicyConfig {
  mode?: CoarsePercentilesMode;
  weakContextCapPct?: number;
  strongRiskOnCapPct?: number;
  strongRiskOnMinConfidence?: number;
  strongRiskOnRequireLowVol?: boolean;
  strongRiskOnRequireLowTransitionRisk?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeEquityRegimeLabel = (label: EquityRegimeLabel): 'risk_on' | 'risk_off' | 'neutral' | undefined => {
  if (!label) return undefined;
  if (label === 'RISK_ON' || label === 'risk_on') return 'risk_on';
  if (label === 'RISK_OFF' || label === 'risk_off') return 'risk_off';
  return 'neutral';
};

export const mapPolicyExposureCap = (
  equityConfidence: number,
  regimeLabel?: EquityRegimeLabel,
  volLabel?: VolRegimeLabel
): number => {
  const confidence = clamp(equityConfidence, 0, 1);
  const normalizedRegimeLabel = normalizeEquityRegimeLabel(regimeLabel);
  const isNeutralLowVol = normalizedRegimeLabel === 'neutral' && volLabel === 'low';
  const isSmoothReRiskingCase = normalizedRegimeLabel === 'risk_on' || isNeutralLowVol;

  if (isSmoothReRiskingCase) {
    if (confidence <= 0.5) return 0.35;
    if (confidence >= 0.8) return 1;
    const t = (confidence - 0.5) / 0.3;
    return clamp(0.35 + t * (1 - 0.35), 0.35, 1);
  }

  if (confidence < 0.35) return 0.35;
  if (confidence < 0.6) return 0.6;
  return 1;
};

export interface PolicyExposureCapInputs {
  equityConfidence: number;
  regimeLabel?: EquityRegimeLabel;
  volLabel?: VolRegimeLabel;
  hasMacroLag?: boolean;
  hasCoarsePercentiles?: boolean;
  transitionRisk?: TransitionRisk;
  coarsePercentilesPolicy?: CoarsePercentilesPolicyConfig;
}

const deriveCoarsePercentilesCap = ({
  exposureCap,
  equityConfidence,
  regimeLabel,
  volLabel,
  transitionRisk,
  coarsePercentilesPolicy
}: {
  exposureCap: number;
  equityConfidence: number;
  regimeLabel?: EquityRegimeLabel;
  volLabel?: VolRegimeLabel;
  transitionRisk?: TransitionRisk;
  coarsePercentilesPolicy?: CoarsePercentilesPolicyConfig;
}): number => {
  const weakContextCapPct = clamp(coarsePercentilesPolicy?.weakContextCapPct ?? 0.7, 0.35, 1);
  const mode = coarsePercentilesPolicy?.mode ?? 'hard_cap';
  if (mode !== 'conditioned_risk_on') {
    return Math.min(exposureCap, weakContextCapPct);
  }

  const normalizedRegimeLabel = normalizeEquityRegimeLabel(regimeLabel);
  const strongRiskOnMinConfidence = clamp(coarsePercentilesPolicy?.strongRiskOnMinConfidence ?? 0.8, 0, 1);
  const strongRiskOnCapPct = clamp(
    coarsePercentilesPolicy?.strongRiskOnCapPct ?? 0.85,
    weakContextCapPct,
    1
  );
  const strongRiskOnRequireLowVol = coarsePercentilesPolicy?.strongRiskOnRequireLowVol ?? true;
  const strongRiskOnRequireLowTransitionRisk = coarsePercentilesPolicy?.strongRiskOnRequireLowTransitionRisk ?? true;
  const strongRiskOnContext =
    normalizedRegimeLabel === 'risk_on' &&
    clamp(equityConfidence, 0, 1) >= strongRiskOnMinConfidence &&
    (!strongRiskOnRequireLowVol || volLabel === 'low') &&
    (!strongRiskOnRequireLowTransitionRisk || !transitionRisk || transitionRisk === 'low');

  return Math.min(exposureCap, strongRiskOnContext ? strongRiskOnCapPct : weakContextCapPct);
};

export const derivePolicyExposureCap = ({
  equityConfidence,
  regimeLabel,
  volLabel,
  hasMacroLag = false,
  hasCoarsePercentiles = false,
  transitionRisk,
  coarsePercentilesPolicy
}: PolicyExposureCapInputs): number => {
  let exposureCap = mapPolicyExposureCap(equityConfidence, regimeLabel, volLabel);
  if (hasMacroLag) exposureCap = Math.min(exposureCap, 0.7);
  if (hasCoarsePercentiles) {
    exposureCap = deriveCoarsePercentilesCap({
      exposureCap,
      equityConfidence,
      regimeLabel,
      volLabel,
      transitionRisk,
      coarsePercentilesPolicy
    });
  }
  if (transitionRisk === 'high') exposureCap = Math.min(exposureCap, 0.35);
  else if (transitionRisk === 'elevated') exposureCap = Math.min(exposureCap, 0.6);
  return exposureCap;
};
