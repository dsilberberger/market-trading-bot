import fs from 'fs';
import path from 'path';
import { Holding, SleevePositions } from '../core/types';

const dataDir = path.resolve(process.cwd(), 'data_cache');

const positionsPath = (env?: string, accountKey?: string) => {
  const suffix = [env || 'default', accountKey || 'default'].filter(Boolean).join('.');
  return path.join(dataDir, `sleeve_positions.${suffix}.json`);
};

const ensureDir = () => {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
};

export const loadSleevePositions = (env?: string, accountKey?: string): SleevePositions => {
  ensureDir();
  const p = positionsPath(env, accountKey);
  if (!fs.existsSync(p)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return json || {};
  } catch {
    return {};
  }
};

export const saveSleevePositions = (positions: SleevePositions, env?: string, accountKey?: string) => {
  ensureDir();
  const p = positionsPath(env, accountKey);
  fs.writeFileSync(p, JSON.stringify(positions, null, 2));
};

export interface SleeveReconcileResult {
  positions: SleevePositions;
  flags: Array<{ code: string; severity: 'info' | 'warn'; message: string; observed?: any }>;
}

export const reconcileSleevePositions = (
  holdings: Holding[],
  positions: SleevePositions
): SleeveReconcileResult => {
  const flags: SleeveReconcileResult['flags'] = [];
  const now = new Date().toISOString();
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

export const snapshotSleevePositions = (positions: SleevePositions) => ({
  updatedAtISO: new Date().toISOString(),
  positions
});
