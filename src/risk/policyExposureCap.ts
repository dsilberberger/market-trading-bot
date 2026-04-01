type EquityRegimeLabel = 'risk_on' | 'risk_off' | 'neutral' | 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL' | undefined;
type VolRegimeLabel = 'low' | 'rising' | 'stressed' | undefined;
type TransitionRisk = 'low' | 'elevated' | 'high' | undefined;

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
}

export const derivePolicyExposureCap = ({
  equityConfidence,
  regimeLabel,
  volLabel,
  hasMacroLag = false,
  hasCoarsePercentiles = false,
  transitionRisk
}: PolicyExposureCapInputs): number => {
  let exposureCap = mapPolicyExposureCap(equityConfidence, regimeLabel, volLabel);
  if (hasMacroLag) exposureCap = Math.min(exposureCap, 0.7);
  if (hasCoarsePercentiles) exposureCap = Math.min(exposureCap, 0.7);
  if (transitionRisk === 'high') exposureCap = Math.min(exposureCap, 0.35);
  else if (transitionRisk === 'elevated') exposureCap = Math.min(exposureCap, 0.6);
  return exposureCap;
};
