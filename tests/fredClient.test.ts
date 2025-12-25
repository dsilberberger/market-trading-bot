import fs from 'fs';
import os from 'os';
import path from 'path';

describe('FredClient caching and parsing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-cache-'));
  const originalCwd = process.cwd();
  beforeAll(() => {
    process.chdir(tmp);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  it('parses values, drops dots, caches to disk, and survives fetch failure', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          observations: [
            { date: '2020-01-01', value: '1.0' },
            { date: '2020-02-01', value: '.' },
            { date: '2020-03-01', value: '2.0' }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'fail'
      } as any);
    (global as any).fetch = mockFetch;
    const { FredClient } = await import('../src/macro/fredClient');
    const client = new FredClient('test-key');
    const series = await client.getSeries('TEST');
    expect(series.points).toHaveLength(2);
    const cacheFile = path.join(tmp, 'data_cache', 'macro', 'fred', 'TEST.json');
    expect(fs.existsSync(cacheFile)).toBe(true);
    // second call should fall back to cache even if fetch fails
    const second = await client.getSeries('TEST');
    expect(second.points).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
