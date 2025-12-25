import fs from 'fs';
import path from 'path';
import { BotConfig, LLMContextPacket, PortfolioState } from '../core/types';

export const buildLLMPrompt = (
  asOf: string,
  universe: string[],
  config: BotConfig,
  portfolio: PortfolioState
): string => {
  const runId = asOf.replace(/:/g, '-');
  const ctxPath = path.resolve(process.cwd(), 'runs', runId, 'llm_context.json');
  let ctxSnippet = 'Context missing; focus on portfolio + constraints.';
  if (fs.existsSync(ctxPath)) {
    const raw = JSON.parse(fs.readFileSync(ctxPath, 'utf-8')) as LLMContextPacket;
    const featureLines =
      raw.features
        ?.slice(0, 8)
        ?.map(
          (f) =>
            `${f.symbol}: px ${f.price?.toFixed?.(2) ?? 'n/a'}, r60 ${
              f.return60d !== undefined ? (f.return60d * 100).toFixed(1) : 'n/a'
            }%, vol20 ${f.realizedVol20d !== undefined ? (f.realizedVol20d * 100).toFixed(1) : 'n/a'}%, trend ${f.trend ?? 'n/a'}`
        )
        .join('; ') ?? '';
    const regimeLine = raw.regimes
      ? `Regime -> growth ${raw.regimes.growth}, inflation ${raw.regimes.inflation}, policy ${raw.regimes.policy}, risk ${raw.regimes.risk}`
      : '';
    const macroLine = raw.macroPolicy ? `Macro policy: ${JSON.stringify(raw.macroPolicy).slice(0, 300)}` : '';
    ctxSnippet = [featureLines, regimeLine, macroLine].filter(Boolean).join('\n');
  }
  const constraintLine = `Constraints: max positions ${config.maxPositions}, min cash ${(config.minCashPct * 100).toFixed(
    1
  )}%, max position ${(config.maxPositionPct * 100).toFixed(1)}%, turnover cap ${(config.maxNotionalTradedPctPerRun * 100).toFixed(
    1
  )}%, min hold hours ${config.minHoldHours}, drawdown stop ${(config.maxWeeklyDrawdownPct * 100).toFixed(1)}%`;
  return [
    'You are a disciplined ETF allocator.',
    `Date: ${asOf}`,
    `Universe: ${universe.join(', ')}`,
    `Capital: ${portfolio.cash.toFixed(2)} cash, equity ${portfolio.equity.toFixed(2)}`,
    constraintLine,
    ctxSnippet,
    'Respond ONLY with JSON matching the trade intent schema. Schema: {"asOf": string, "universe": string[], "orders":[{"symbol": string (must be in universe), "side":"BUY"|"SELL", "orderType":"MARKET"|"LIMIT", "notionalUSD": number>0, "thesis": string<=400, "invalidation": string<=200, "confidence": number 0..1, "portfolioLevel":{"targetHoldDays":int,"netExposureTarget":0..1}}]}'
  ].join('\n');
};
