import { BotConfig, TradeOrder } from './types';

interface NavResult {
  nav: number;
  invested: number;
  cash: number;
}

export const computeNav = (holdings: Array<{ symbol: string; quantity: number }>, cash: number, quotes: Record<string, number>): NavResult => {
  const invested = (holdings || []).reduce((acc, h) => {
    const px = quotes?.[h.symbol] ?? 0;
    return acc + (h.quantity || 0) * px;
  }, 0);
  const nav = invested + (cash || 0);
  return { nav, invested, cash: cash || 0 };
};

export const computeBudgets = (nav: number, config: BotConfig) => {
  const corePct = config.capital?.corePct ?? 0.7;
  const reservePct = config.capital?.reservePct ?? 0.3;
  const coreBudget = nav * corePct;
  const reserveBudget = nav * reservePct;
  return { coreBudget, reserveBudget };
};

export const clampBuyOrdersToBudget = (orders: TradeOrder[], maxBuyNotional: number) => {
  const buys = orders.filter((o) => o.side === 'BUY');
  const buyTotal = buys.reduce((acc, o) => acc + o.notionalUSD, 0);
  if (buyTotal <= maxBuyNotional || buyTotal === 0) return orders;
  const scale = maxBuyNotional / buyTotal;
  return orders.map((o) => {
    if (o.side !== 'BUY') return o;
    return { ...o, notionalUSD: o.notionalUSD * scale };
  });
};

export const computeCoreDeployPct = (
  regimes: any,
  config: BotConfig
): { deployPct: number; confidenceScale: number } => {
  const label = regimes?.equityRegime?.label;
  const confidence = regimes?.equityRegime?.confidence ?? 1;
  const baseDeployMap =
    config.capital?.baseDeployPct || { risk_off: 0.35, neutral: 0.6, risk_on: 0.8, fallback: 0.5 };
  let basePct = baseDeployMap.fallback ?? 0.5;
  if (label === 'risk_off') basePct = baseDeployMap.risk_off ?? basePct;
  else if (label === 'neutral') basePct = baseDeployMap.neutral ?? basePct;
  else if (label === 'risk_on') basePct = baseDeployMap.risk_on ?? basePct;
  const confThreshold = config.capital?.deployConfThreshold ?? 0.5;
  const scaleLow = config.capital?.deployConfScaleLow ?? 0.9;
  const confidenceScale = confidence < confThreshold ? scaleLow : 1;
  const deployPct = Math.min(1, Math.max(0, basePct * confidenceScale));
  return { deployPct, confidenceScale };
};
