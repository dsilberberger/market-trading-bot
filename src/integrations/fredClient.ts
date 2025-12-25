import path from 'path';
import { ensureDir, writeJSONFile } from '../core/utils';

const FRED_API = 'https://api.stlouisfed.org/fred';

export interface FredSeriesPoint {
  date: string;
  value: number;
}

export interface FredSeriesResult {
  id: string;
  title?: string;
  points: FredSeriesPoint[];
}

const parseSeries = (json: any): FredSeriesPoint[] => {
  if (!json?.observations) return [];
  return json.observations
    .map((o: any) => ({ date: o.date, value: Number(o.value) }))
    .filter((p: FredSeriesPoint) => !Number.isNaN(p.value));
};

export class FredClient {
  private apiKey?: string;
  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private async fetchSeries(seriesId: string, limit = 104): Promise<FredSeriesResult> {
    if (!this.apiKey) {
      return { id: seriesId, points: [] };
    }
    const url = new URL(`${FRED_API}/series/observations`);
    url.searchParams.set('series_id', seriesId);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('limit', `${limit}`);
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`FRED request failed ${resp.status}: ${text}`);
    }
    const json = await resp.json();
    return { id: seriesId, title: json?.seriess?.[0]?.title, points: parseSeries(json) };
  }

  public async getMacroSnapshot(series: string[]): Promise<FredSeriesResult[]> {
    const results: FredSeriesResult[] = [];
    for (const id of series) {
      try {
        results.push(await this.fetchSeries(id));
      } catch (err) {
        results.push({ id, points: [] });
      }
    }
    return results;
  }
}

export const writeContextPacket = (runId: string, data: unknown) => {
  const outDir = path.resolve(process.cwd(), 'context');
  ensureDir(outDir);
  const outPath = path.join(outDir, `${runId}.json`);
  writeJSONFile(outPath, data);
  return outPath;
};
