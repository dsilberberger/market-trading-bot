import fs from 'fs';
import path from 'path';

export type SleevePhase = 'INACTIVE' | 'ADD' | 'HOLD' | 'REINTEGRATE' | 'EXITED';

export interface DislocationSleeveState {
  active: boolean;
  phase: SleevePhase;
  triggeredAtISO?: string;
  addUntilISO?: string;
  holdUntilISO?: string;
  reintegrateAfterISO?: string;
  lastTriggerKey?: string;
  entryAnchorPrice?: number;
  troughAnchorPrice?: number;
  troughDateISO?: string;
  lastSeenAnchorPrice?: number;
  cooldownUntilISO?: string;
  notes?: string[];
  currentTier?: number;
  lastTierChangeISO?: string;
  lastTier?: number;
}

const statePath = path.resolve(process.cwd(), 'data_cache', 'dislocation_sleeve_state.json');

export const loadSleeveState = (): DislocationSleeveState => {
  try {
    if (!fs.existsSync(statePath)) return { active: false, phase: 'INACTIVE' };
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as DislocationSleeveState;
  } catch {
    return { active: false, phase: 'INACTIVE' };
  }
};

export const saveSleeveState = (s: DislocationSleeveState) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
};
