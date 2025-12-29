import { BotConfig } from '../core/types';

export type OptionsIntent = 'HEDGE' | 'GROWTH';

export interface UnderlyingSelectionResult {
  symbol: string | null;
  tried: string[];
}

const isUsableStub = (_symbol: string) => true; // placeholder until chain checks exist

export const selectOptionsUnderlying = (
  intent: OptionsIntent,
  config: BotConfig
): UnderlyingSelectionResult => {
  const tried: string[] = [];
  const preferredList =
    intent === 'HEDGE' ? config.hedgeProxyPolicy?.hedgePreferred : config.hedgeProxyPolicy?.growthPreferred;
  const ordered = preferredList && preferredList.length ? preferredList : config.optionsUnderlyings || [];

  for (const sym of ordered) {
    tried.push(sym);
    if (isUsableStub(sym)) {
      return { symbol: sym, tried };
    }
  }

  return { symbol: null, tried };
};
