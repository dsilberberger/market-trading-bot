import { FredSeriesResult } from './fredClient';

export class FredClientStub {
  async getMacroSnapshot(series: string[]): Promise<FredSeriesResult[]> {
    return series.map((id) => ({ id, points: [] }));
  }
}
