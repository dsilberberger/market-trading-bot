import fs from 'fs';
import path from 'path';
import { BotConfig } from './types';

export const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

export const readJSONFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
};

export const writeJSONFile = (filePath: string, data: unknown) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

export const loadConfig = (configPath: string): BotConfig => {
  const cfg = readJSONFile<BotConfig>(configPath);
  return cfg;
};

export const loadUniverse = (universePath: string): string[] => {
  return readJSONFile<string[]>(universePath);
};

export const mulberry32 = (seed: number) => {
  let t = seed + 0x6d2b79f5;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

// Deterministic hash (FNV-1a variant) to reduce collisions for seeded randomness.
export const hashString = (input: string): number => {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
};

export const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);

export const average = (arr: number[]): number => (arr.length ? sum(arr) / arr.length : 0);
