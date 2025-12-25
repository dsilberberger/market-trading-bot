import { SymbolFeature, TradeOrder } from '../core/types';

export interface InvalidationResult {
  orders: TradeOrder[];
  flags: { code: string; severity: 'warn' | 'info'; message: string; symbols?: string[]; observed?: Record<string, unknown> }[];
}

export const anchorInvalidations = (orders: TradeOrder[], features: SymbolFeature[]): InvalidationResult => {
  const flags: InvalidationResult['flags'] = [];
  const featureMap = new Map<string, SymbolFeature>(features.map((f) => [f.symbol, f]));
  const updated = orders.map((o) => {
    if (o.side !== 'BUY') return o;
    const feat = featureMap.get(o.symbol);
    if (!feat) return o;
    const ma200 = feat.ma200 ?? feat.ma50 ?? feat.price;
    const draw = feat.maxDrawdown60d ?? 0.05;
    const invText = `Invalidate if weekly close < MA200 (${ma200?.toFixed?.(2)}) or drawdown > ${(
      (draw + 0.02) *
      100
    ).toFixed(1)}% from entry.`;
    const needsAnchor =
      !o.invalidation || !/MA/i.test(o.invalidation) || !/drawdown|close|ma/i.test(o.invalidation);
    if (needsAnchor) {
      flags.push({
        code: 'INVALIDATION_REANCHORED',
        severity: 'warn',
        message: `Anchored invalidation for ${o.symbol}`,
        symbols: [o.symbol],
        observed: { original: o.invalidation }
      });
      return { ...o, invalidation: invText };
    }
    return o;
  });
  return { orders: updated, flags };
};
