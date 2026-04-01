import { BotConfig, ExecutionResult, TradeOrder, OrderPreview, OrderPlacement, Fill, Mode } from '../core/types';
import { Broker } from '../broker/broker.types';
import { appendEvent, makeEvent } from '../ledger/ledger';
import { writeRunArtifact } from '../ledger/storage';
import { getRebalanceKey } from '../core/time';

export interface ExecutionOptions {
  dryRun?: boolean;
  pendingApproval?: boolean;
  mode?: Mode;
  brokerProvider?: string;
  pollFillsAttempts?: number;
  pollFillsDelayMs?: number;
}

export const executeOrders = async (
  runId: string,
  asOf: string,
  orders: TradeOrder[],
  broker: Broker,
  config: BotConfig,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> => {
  const previews: OrderPreview[] = [];
  const placements: OrderPlacement[] = [];
  const fills: any[] = [];
  const execFlags: any[] = [];
  const placedOrders: Array<{ orderId: string; order: TradeOrder }> = [];

  // Reprice just before preview/placement to avoid sub-1-share failures from small price drift.
  const repricedOrders: TradeOrder[] = orders.map((o) => {
    // We do not have a price map here; rely on notional vs price from the broker preview.
    // To avoid sub-1-share, if notionalUSD would imply <1 share at a later price,
    // the broker.previewOrder will throw; to preempt, we bump notional to at least the
    // planned price * 1 share only when it was sized below $1 (unlikely) or explicitly zero.
    // Since we don't have live price here, leave notional as-is; the broker layer will enforce min-share.
    return o;
  });

  if (options.pendingApproval) {
    writeRunArtifact(runId, 'orders.json', orders);
    writeRunArtifact(runId, 'fills.json', [{ type: 'NO_FILL', reason: 'PENDING_APPROVAL' }]);
    writeRunArtifact(runId, 'execution_flags.json', [{ code: 'EXECUTION_SKIPPED_PENDING_APPROVAL' }]);
    return { previews, placements, fills, placedOrders };
  }

  if (options.dryRun) {
    writeRunArtifact(runId, 'orders.json', orders);
    writeRunArtifact(runId, 'fills.json', [{ type: 'NO_FILL', reason: 'DRY_RUN' }]);
    writeRunArtifact(runId, 'execution_flags.json', [{ code: 'EXECUTION_SKIPPED', reason: 'DRY_RUN' }]);
    return { previews, placements, fills, placedOrders };
  }
  for (const order of orders) {
    const preview = await broker.previewOrder(order, asOf);
    previews.push(preview);
    appendEvent(makeEvent(runId, 'ORDER_PREVIEWED', { order, preview }));
    try {
      const placement = await broker.placeOrder(order, asOf);
      placements.push(placement);
      placedOrders.push({ orderId: String(placement.orderId), order });
      appendEvent(makeEvent(runId, 'ORDER_PLACED', { order, placement }));
    } catch (err) {
      execFlags.push({ code: 'EXECUTION_FAILED', message: (err as Error).message, symbol: order.symbol });
      fills.push({ type: 'NO_FILL', reason: 'BROKER_ERROR', message: (err as Error).message, symbol: order.symbol });
    }
  }

  if (placements.length) {
    const orderIds = placements.map((p) => String(p.orderId));
    const attemptMax = options.pollFillsAttempts ?? (process.env.USE_ETRADE_ORDERS === 'true' && options.mode === 'live' ? 3 : 1);
    const delayMs = options.pollFillsDelayMs ?? 2000;
    for (let i = 0; i < attemptMax; i++) {
      const fetchedFills = await broker.getFills(orderIds, asOf);
      const nonZero = fetchedFills.filter((f) => f.quantity > 0);
      for (const fill of fetchedFills) {
        fills.push(fill);
        appendEvent(makeEvent(runId, 'FILL_RECORDED', { fill }));
      }
      if (nonZero.length || i === attemptMax - 1) {
        break;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    // record execution event (paper or live)
    const rebalanceKey = getRebalanceKey(new Date(asOf), config.rebalanceDay || 'TUESDAY');
    appendEvent(
      makeEvent(runId, 'EXECUTION_SENT_TO_BROKER', {
        asOf,
        rebalanceKey,
        mode: options.mode || 'paper',
        brokerProvider: options.brokerProvider || process.env.BROKER_PROVIDER || 'stub',
        orderCount: placements.length
      })
    );
  }

  writeRunArtifact(runId, 'orders.json', orders);
  if (placements.length) writeRunArtifact(runId, 'placements.json', placements);
  writeRunArtifact(runId, 'fills.json', fills.length ? fills : [{ type: 'NO_FILL', reason: 'NO_EXECUTIONS' }]);
  if (execFlags.length) writeRunArtifact(runId, 'execution_flags.json', execFlags);

  return { previews, placements, fills, placedOrders };
};
