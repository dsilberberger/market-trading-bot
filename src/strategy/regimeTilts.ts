import { RegimeContext } from '../core/types';

type ExposureBucket = 'equity_large' | 'equity_growth' | 'equity_small' | 'duration_long' | 'duration_short' | 'gold' | 'unknown';

const bucketForSymbol = (symbol: string): ExposureBucket => {
  const sym = symbol.toUpperCase();
  if (sym === 'QQQ' || sym === 'QQQM') return 'equity_growth';
  if (sym === 'IWM') return 'equity_small';
  if (sym === 'SPY' || sym === 'SPYM') return 'equity_large';
  if (sym === 'TLT' || sym === 'IEF') return 'duration_long';
  if (sym === 'SHY' || sym === 'BIL' || sym === 'CASH') return 'duration_short';
  if (sym === 'GLD' || sym === 'IAU') return 'gold';
  return 'unknown';
};

export const regimeTiltForSymbol = (regimes: RegimeContext | undefined, symbol: string): { multiplier: number; reasons: string[] } => {
  if (!regimes) return { multiplier: 1, reasons: ['no_regime'] };
  const bucket = bucketForSymbol(symbol);
  let m = 1;
  const reasons: string[] = [];

  // Equity regime tilt
  const eq = regimes.equityRegime;
  if (eq?.label === 'risk_on') {
    if (bucket.startsWith('equity')) {
      m *= 1.2;
      reasons.push('equity_risk_on');
    }
  } else if (eq?.label === 'risk_off') {
    if (bucket.startsWith('equity')) {
      m *= 0.8;
      reasons.push('equity_risk_off');
    }
    if (bucket === 'duration_long' || bucket === 'duration_short' || bucket === 'gold') {
      m *= 1.1;
      reasons.push('defensive_boost');
    }
  }
  if ((eq?.confidence ?? 1) < 0.4 && bucket.startsWith('equity')) {
    m *= 0.9;
    reasons.push('low_equity_confidence');
  }
  if (eq?.transitionRisk === 'high') {
    m *= 0.9;
    reasons.push('transition_risk');
  }

  // Vol regime tilt
  const volLabel = regimes.volRegime?.label;
  if (volLabel === 'stressed') {
    if (bucket === 'equity_growth' || bucket === 'equity_small') {
      m *= 0.85;
      reasons.push('vol_stressed_equity');
    }
    if (bucket === 'duration_long' || bucket === 'gold') {
      m *= 1.1;
      reasons.push('vol_stressed_defense');
    }
  } else if (volLabel === 'rising' && bucket === 'equity_growth') {
    m *= 0.95;
    reasons.push('vol_rising_growth');
  }

  // Rates tilt
  const stance = regimes.ratesRegime?.stance;
  const ratesLabel = regimes.ratesRegime?.label;
  if ((stance === 'restrictive' || ratesLabel === 'rising') && bucket === 'duration_long') {
    m *= 0.85;
    reasons.push('rates_restrictive_duration');
  } else if (ratesLabel === 'falling' && bucket === 'duration_long') {
    m *= 1.1;
    reasons.push('rates_falling_duration');
  }
  if (stance === 'restrictive' && bucket === 'duration_short') {
    m *= 1.05;
    reasons.push('short_duration_preferred');
  }

  return { multiplier: m, reasons };
};
