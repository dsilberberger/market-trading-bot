import fs from 'fs';
import path from 'path';
import { ensureDir } from '../core/utils';

export interface FredSeriesPoint {
  date: string;
  value: number;
}

export interface FredSeriesResult {
  id: string;
  title?: string;
  points: FredSeriesPoint[];
}

const FRED_API = 'https://api.stlouisfed.org/fred';
const cacheRoot = path.resolve(process.cwd(), 'data_cache', 'macro', 'fred');

const loadCache = (seriesId: string): FredSeriesPoint[] => {
  const file = path.join(cacheRoot, `${seriesId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as FredSeriesPoint[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

const saveCache = (seriesId: string, points: FredSeriesPoint[]) => {
  ensureDir(cacheRoot);
  const file = path.join(cacheRoot, `${seriesId}.json`);
  fs.writeFileSync(file, JSON.stringify(points, null, 2));
};

const mergePoints = (existing: FredSeriesPoint[], incoming: FredSeriesPoint[]): FredSeriesPoint[] => {
  const map = new Map<string, number>();
  for (const p of existing) map.set(p.date, p.value);
  for (const p of incoming) map.set(p.date, p.value);
  return Array.from(map.entries())
    .map(([date, value]: [string, number]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
};

const parseSeries = (json: any): FredSeriesPoint[] => {
  if (!json?.observations) return [];
  return json.observations
    .map((o: any) => {
      const val = o?.value;
      if (val === '.' || val === null || val === undefined) return undefined;
      const num = Number(val);
      if (Number.isNaN(num)) return undefined;
      return { date: o.date, value: num };
    })
    .filter((p: FredSeriesPoint | undefined): p is FredSeriesPoint => Boolean(p));
};

export class FredClient {
  private apiKey?: string;
  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private async fetchFromApi(seriesId: string, start?: string): Promise<FredSeriesPoint[]> {
    if (!this.apiKey) return [];
    const url = new URL(`${FRED_API}/series/observations`);
    url.searchParams.set('series_id', seriesId);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('file_type', 'json');
    if (start) url.searchParams.set('observation_start', start);
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`FRED request failed ${resp.status}: ${text}`);
    }
    const json = await resp.json();
    return parseSeries(json);
  }

  public async getSeries(seriesId: string): Promise<FredSeriesResult> {
    const cached = loadCache(seriesId);
    const lastDate = cached.length ? cached[cached.length - 1].date : undefined;
    let newPoints: FredSeriesPoint[] = [];
    try {
      newPoints = await this.fetchFromApi(seriesId, lastDate);
    } catch (err) {
      // swallow to allow cached data use
      newPoints = [];
    }
    const merged = mergePoints(cached, newPoints);
    if (merged.length !== cached.length || newPoints.length) {
      saveCache(seriesId, merged);
    }
    return { id: seriesId, points: merged };
  }

  public async getMacroSnapshot(series: string[]): Promise<FredSeriesResult[]> {
    const results: FredSeriesResult[] = [];
    for (const id of series) {
      try {
        results.push(await this.getSeries(id));
      } catch {
        results.push({ id, points: [] });
      }
    }
    return results;
  }
}
