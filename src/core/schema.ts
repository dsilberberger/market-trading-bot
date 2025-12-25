import { z } from 'zod';
import { TradeIntent, TradeOrder } from './types';

const portfolioLevelSchema = z.object({
  targetHoldDays: z.number().int().min(1),
  netExposureTarget: z.number().min(0).max(1)
});

export const buildTradeOrderSchema = (universe: string[]) =>
  z.object({
    symbol: z.string().refine((val) => universe.includes(val), {
      message: 'symbol must be part of universe'
    }),
    side: z.enum(['BUY', 'SELL']),
    orderType: z.enum(['MARKET', 'LIMIT']),
    notionalUSD: z.number().positive(),
    thesis: z.string().max(400),
    invalidation: z.string().max(200),
    confidence: z.number().min(0).max(1),
    portfolioLevel: portfolioLevelSchema
  });

export const buildTradeIntentSchema = (universe: string[]) =>
  z.object({
    asOf: z.string().refine((val) => !Number.isNaN(Date.parse(val)), {
      message: 'asOf must be ISO date'
    }),
    universe: z.array(z.string()).nonempty(),
    orders: z.array(buildTradeOrderSchema(universe)),
    portfolioLevel: portfolioLevelSchema.optional()
  });

export const validateTradeIntent = (
  intent: unknown,
  universe: string[]
): { success: true; value: TradeIntent } | { success: false; errors: string[] } => {
  const schema = buildTradeIntentSchema(universe);
  const result = schema.safeParse(intent);
  if (result.success) {
    return { success: true, value: result.data };
  }
  const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return { success: false, errors };
};

export const sanitizeOrders = (orders: TradeOrder[], universe: string[]): TradeOrder[] => {
  const schema = buildTradeOrderSchema(universe);
  return orders
    .map((order) => schema.safeParse(order))
    .filter((r): r is z.SafeParseSuccess<TradeOrder> => r.success)
    .map((r) => r.data);
};
