export interface FinnhubNewsItem {
  headline: string;
  url: string;
  datetime?: string;
  source?: string;
}

const defaultKeywords = ['ETF', 'stocks', 'markets', 'rates', 'inflation', 'equity', 'bonds', 'treasury', 'SPY', 'QQQ'];

export class FinnhubClient {
  private apiKey: string;
  private universe: string[];
  private keywords: string[];
  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.universe = (process.env.NEWS_SYMBOL_FILTER || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.keywords = defaultKeywords;
  }

  private matchesFilters(item: FinnhubNewsItem): boolean {
    const text = `${item.headline} ${item.source}`.toLowerCase();
    if (this.universe.length && this.universe.some((sym) => text.includes(sym.toLowerCase()))) return true;
    if (this.keywords.some((k) => text.includes(k.toLowerCase()))) return true;
    return false;
  }

  public async getLatestNews(limit = 8): Promise<FinnhubNewsItem[]> {
    const url = new URL('https://finnhub.io/api/v1/news');
    url.searchParams.set('category', 'general');
    url.searchParams.set('token', this.apiKey);
    url.searchParams.set('minId', '0');
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Finnhub news failed ${resp.status}: ${text}`);
    }
    const json = (await resp.json()) as any[];
    const items = (json || [])
      .map((n) => ({
        headline: n.headline,
        url: n.url,
        datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : undefined,
        source: n.source
      }))
      .filter((n) => n.headline && n.url)
      .filter((n) => this.matchesFilters(n))
      .slice(0, limit);
    return items;
  }
}

export const getFinnhubClient = (): FinnhubClient | null => {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  return new FinnhubClient(key);
};
