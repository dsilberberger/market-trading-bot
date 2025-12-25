import { BotConfig, PortfolioState, ProposalResult, TradeIntent, TradeOrder } from '../core/types';
import { MarketDataProvider } from '../data/marketData.types';
import { buildLLMPrompt } from './llmPrompt';
import { mulberry32 } from '../core/utils';
import { seedFromDate } from '../core/time';
import { validateTradeIntent } from '../core/schema';
import { getLLMClient } from './openaiClient';

export interface LLMClient {
  complete(prompt: string): Promise<string>;
}

export class StubLLMClient implements LLMClient {
  private asOf: string;
  private universe: string[];
  private config: BotConfig;
  private portfolio: PortfolioState;
  private marketData: MarketDataProvider;

  constructor(asOf: string, universe: string[], config: BotConfig, portfolio: PortfolioState, marketData: MarketDataProvider) {
    this.asOf = asOf;
    this.universe = universe;
    this.config = config;
    this.portfolio = portfolio;
    this.marketData = marketData;
  }

  async complete(_prompt: string): Promise<string> {
    const rng = mulberry32(seedFromDate(this.asOf));
    const shuffled = this.universe.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const picks = shuffled.slice(0, Math.min(2, this.config.maxPositions));
    const minCashBuffer = this.portfolio.equity * this.config.minCashPct;
    const availableCash = Math.max(0, this.portfolio.cash - minCashBuffer);
    const cashToDeploy = availableCash;
    const orders: TradeOrder[] = [];
    for (const symbol of picks) {
      const quote = await this.marketData.getQuote(symbol, this.asOf);
      const per = picks.length
        ? Math.min(cashToDeploy / picks.length, this.portfolio.equity * this.config.maxPositionPct)
        : 0;
      if (per <= 0) continue;
      orders.push({
        symbol,
        side: 'BUY',
        orderType: 'MARKET',
        notionalUSD: Number(per.toFixed(2)),
        thesis: `Stub LLM allocation toward ${symbol}.`,
        invalidation: 'Breaks weekly momentum stub.',
        confidence: 0.65,
        portfolioLevel: { targetHoldDays: 30, netExposureTarget: 1 }
      });
    }
    const intent: TradeIntent = { asOf: this.asOf, universe: this.universe, orders };
    return JSON.stringify(intent);
  }
}

const cleanLLMJson = (raw: string): string => {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
};

export const generateLLMProposal = async (
  asOf: string,
  universe: string[],
  config: BotConfig,
  portfolio: PortfolioState,
  marketData: MarketDataProvider,
  client?: LLMClient
): Promise<{ success: true; result: ProposalResult } | { success: false; errors: string[]; raw?: unknown }> => {
  const prompt = buildLLMPrompt(asOf, universe, config, portfolio);
  const realClient = getLLMClient();
  const llmClient = client ?? realClient ?? new StubLLMClient(asOf, universe, config, portfolio, marketData);
  try {
    const response = await llmClient.complete(prompt);
    const cleaned = cleanLLMJson(response);
    const parsed = JSON.parse(cleaned);
    const validation = validateTradeIntent(parsed, universe);
    if (validation.success) {
      return { success: true, result: { strategy: 'llm', intent: validation.value } };
    }
    return { success: false, errors: validation.errors, raw: parsed };
  } catch (err) {
    return { success: false, errors: [(err as Error).message] };
  }
};
