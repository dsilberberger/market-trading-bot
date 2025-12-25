import { Fill, OrderPlacement, OrderPreview, PortfolioState, TradeOrder } from '../core/types';

export interface Broker {
  getPortfolioState(asOf: string): Promise<PortfolioState>;
  previewOrder(order: TradeOrder, asOf: string): Promise<OrderPreview>;
  placeOrder(order: TradeOrder, asOf: string): Promise<OrderPlacement>;
  getFills(orderIds: string[], asOf: string): Promise<Fill[]>;
  cancelOrder(orderId: string): Promise<void>;
}
