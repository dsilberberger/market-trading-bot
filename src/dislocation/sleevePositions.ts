import fs from 'fs';
import path from 'path';
import { Fill, Holding, SleevePositions, TradeOrder } from '../core/types';
import { runtimeNowISO } from '../core/time';

const dataDir = path.resolve(process.cwd(), 'data_cache');

const positionsPath = (env?: string, accountKey?: string) => {
  const override = process.env.SLEEVE_POSITIONS_PATH;
  if (override) return path.resolve(process.cwd(), override);
  const suffix = [env || 'default', accountKey || 'default'].filter(Boolean).join('.');
  return path.join(dataDir, `sleeve_positions.${suffix}.json`);
};

const ensureDir = (filePath?: string) => {
  const dir = filePath ? path.dirname(filePath) : dataDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export const loadSleevePositions = (env?: string, accountKey?: string): SleevePositions => {
  const p = positionsPath(env, accountKey);
  ensureDir(p);
  if (!fs.existsSync(p)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return json || {};
  } catch {
    return {};
  }
};

export const saveSleevePositions = (positions: SleevePositions, env?: string, accountKey?: string) => {
  const p = positionsPath(env, accountKey);
  ensureDir(p);
  fs.writeFileSync(p, JSON.stringify(positions, null, 2));
};

export interface SleeveReconcileResult {
  positions: SleevePositions;
  flags: Array<{ code: string; severity: 'info' | 'warn'; message: string; observed?: any }>;
}

export const reconcileSleevePositions = (
  holdings: Holding[],
  positions: SleevePositions,
  asOf?: string
): SleeveReconcileResult => {
  const flags: SleeveReconcileResult['flags'] = [];
  const now = runtimeNowISO(asOf);
  const pos: SleevePositions = { ...positions };

  const initIfMissing = () => {
    for (const h of holdings) {
      if (!pos[h.symbol]) {
        pos[h.symbol] = { baseQty: h.quantity, dislocationQty: 0, updatedAtISO: now };
      }
    }
  };

  if (!Object.keys(pos).length && holdings.length) {
    initIfMissing();
    flags.push({
      code: 'SLEEVE_POSITIONS_INITIALIZED',
      severity: 'info',
      message: 'Initialized sleeve positions from existing holdings',
      observed: { symbols: holdings.map((h) => h.symbol) }
    });
    return { positions: pos, flags };
  }

  for (const h of holdings) {
    const totalHeld = h.quantity;
    const entry = pos[h.symbol];
    if (!entry) {
      pos[h.symbol] = { baseQty: totalHeld, dislocationQty: 0, updatedAtISO: now };
      flags.push({
        code: 'SLEEVE_RECONCILED',
        severity: 'info',
        message: `Added missing sleeve entry for ${h.symbol}`,
        observed: { totalHeld }
      });
      continue;
    }
    const totalSleeve = (entry.baseQty || 0) + (entry.dislocationQty || 0);
    if (totalSleeve === totalHeld) continue;
    const observed = { totalHeld, totalSleeve, baseQty: entry.baseQty, dislocationQty: entry.dislocationQty };
    if (totalSleeve > totalHeld) {
      // reduce base first, then dislocation
      let reduce = totalSleeve - totalHeld;
      const newBase = Math.max(0, entry.baseQty - reduce);
      reduce -= entry.baseQty - newBase;
      const newDisloc = Math.max(0, entry.dislocationQty - reduce);
      pos[h.symbol] = { baseQty: newBase, dislocationQty: newDisloc, updatedAtISO: now };
    } else {
      // allocate difference to base
      const diff = totalHeld - totalSleeve;
      pos[h.symbol] = {
        baseQty: (entry.baseQty || 0) + diff,
        dislocationQty: entry.dislocationQty || 0,
        updatedAtISO: now
      };
    }
    flags.push({
      code: 'SLEEVE_RECONCILED',
      severity: 'info',
      message: `Reconciled sleeve quantities for ${h.symbol}`,
      observed
    });
  }

  // Remove symbols no longer held
  const heldSet = new Set(holdings.map((h) => h.symbol));
  for (const sym of Object.keys(pos)) {
    if (!heldSet.has(sym) && (pos[sym].baseQty || pos[sym].dislocationQty)) {
      pos[sym] = { baseQty: 0, dislocationQty: 0, updatedAtISO: now };
    }
  }

  return { positions: pos, flags };
};

export const applyFilledSleeveOrders = ({
  positions,
  fills,
  ordersById,
  asOf
}: {
  positions: SleevePositions;
  fills: Fill[];
  ordersById: Record<string, TradeOrder>;
  asOf?: string;
}): SleevePositions => {
  const now = runtimeNowISO(asOf);
  const next: SleevePositions = { ...positions };

  for (const fill of fills || []) {
    const order = ordersById[fill.orderId];
    if (!order || !fill.symbol || !Number.isFinite(fill.quantity) || fill.quantity <= 0) continue;
    const current = next[fill.symbol] || { baseQty: 0, dislocationQty: 0, updatedAtISO: now };
    let baseQty = current.baseQty || 0;
    let dislocationQty = current.dislocationQty || 0;

    if (order.side === 'BUY') {
      if (order.sleeve === 'dislocation') dislocationQty += fill.quantity;
      else baseQty += fill.quantity;
    } else {
      let remaining = fill.quantity;
      if (order.sleeve === 'dislocation') {
        const reduceDislocation = Math.min(dislocationQty, remaining);
        dislocationQty -= reduceDislocation;
        remaining -= reduceDislocation;
      }
      if (remaining > 0) {
        const reduceBase = Math.min(baseQty, remaining);
        baseQty -= reduceBase;
        remaining -= reduceBase;
      }
      if (remaining > 0) {
        dislocationQty = Math.max(0, dislocationQty - remaining);
      }
    }

    next[fill.symbol] = {
      baseQty: Math.max(0, baseQty),
      dislocationQty: Math.max(0, dislocationQty),
      updatedAtISO: now
    };
  }

  return next;
};

export const snapshotSleevePositions = (positions: SleevePositions, asOf?: string) => ({
  updatedAtISO: runtimeNowISO(asOf),
  positions
});
