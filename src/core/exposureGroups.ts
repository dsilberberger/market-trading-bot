import fs from 'fs';
import path from 'path';

export interface ExposureGroupConfig {
  members: string[];
  canonicalPreference?: string[];
  description?: string;
}

export type ExposureGroups = Record<string, ExposureGroupConfig>;

export const loadExposureGroups = (filePath?: string): ExposureGroups => {
  if (!filePath) return {};
  const p = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ExposureGroups;
  } catch {
    return {};
  }
};

export const symbolToExposureKey = (groups: ExposureGroups, symbol: string): string | undefined => {
  for (const [key, cfg] of Object.entries(groups)) {
    if (cfg.members?.includes(symbol)) return key;
  }
  return undefined;
};

export const canonicalSymbolForExposure = (
  groups: ExposureGroups,
  exposureKey: string,
  prices: Record<string, number>,
  onlyIfAffordable = true
): string | undefined => {
  const cfg = groups[exposureKey];
  if (!cfg) return undefined;
  const prefs = cfg.canonicalPreference || cfg.members;
  for (const sym of prefs) {
    const px = prices[sym];
    if (!onlyIfAffordable || (typeof px === 'number' && px > 0)) return sym;
  }
  return prefs[0];
};
