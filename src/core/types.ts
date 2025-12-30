export { PriceBar } from '../data/marketData.types';

export type TradeSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';

export interface PortfolioLevelSettings {
  targetHoldDays: number;
  netExposureTarget: number; // 0..1
}

export interface TradeOrder {
  symbol: string;
  side: TradeSide;
  orderType: OrderType;
  notionalUSD: number;
  thesis: string;
  invalidation: string;
  invalidationOriginal?: string;
  confidence: number;
  portfolioLevel: PortfolioLevelSettings;
  sleeve?: 'base' | 'dislocation';
}

export interface TradeIntent {
  asOf: string; // ISO date
  universe: string[];
  orders: TradeOrder[];
  portfolioLevel?: PortfolioLevelSettings;
}

export type StrategyName = 'llm' | 'deterministic' | 'random';
export type Mode = 'paper' | 'live' | 'backtest';

export type DataQualitySeverity = 'info' | 'warn' | 'error';
export type DataQualityAction = 'block' | 'warn';

export interface DataQualityFlag {
  code: string;
  severity: DataQualitySeverity;
  message: string;
  symbols?: string[];
  observed?: Record<string, unknown> | string | number | string[];
  action?: DataQualityAction;
}

export interface BotConfig {
  startingCapitalUSD: number;
  maxPositions: number;
  rebalanceDay: string;
  maxTradesPerRun: number;
  maxPositionPct: number;
  maxWeeklyDrawdownPct: number;
  minCashPct: number;
  maxNotionalTradedPctPerRun: number;
  minHoldHours: number;
  rebalance?: {
    enabled?: boolean;
    portfolioDriftThreshold?: number;
    positionDriftThreshold?: number;
    minTradeNotionalUSD?: number;
    alwaysRebalanceOnRegimeChange?: boolean;
    regimeChangeKeys?: string[];
    fullExitRemovedSymbols?: boolean;
    rebalanceDustSharesThreshold?: number;
  };
  dislocation?: {
    enabled?: boolean;
    anchorSymbol?: string;
    barInterval?: string;
    fastWindowWeeks?: number;
    slowWindowWeeks?: number;
    peakLookbackWeeks?: number;
    minActiveTier?: number;
    tiers?: Array<{ tier: number; name?: string; peakDrawdownGte: number; overlayExtraExposurePct: number }>;
    fastDrawdownEscalation?: {
      enabled?: boolean;
      tier2FastDrawdownGte?: number;
      tier3FastDrawdownGte?: number;
    };
    slowDrawdownEscalation?: {
      enabled?: boolean;
      tier2SlowDrawdownGte?: number;
      tier3SlowDrawdownGte?: number;
    };
    confirmBreadth?: boolean;
    breadthUniverseSymbols?: string[];
    breadthMinDownCount?: number;
    triggerFastDrawdownPct?: number;
    triggerSlowDrawdownPct?: number;
    opportunisticExtraExposurePct?: number;
    tierHysteresisPct?: number;
    minWeeksBetweenTierChanges?: number;
    overlayExtraExposurePct?: number;
    overlayTargets?: Array<{ symbol: string; weight: number }>;
    overlayExposureKeys?: string[];
    proxyOnlyOverlay?: boolean;
    overlayAllowedSymbols?: string[];
    overlayFundingPolicy?: 'cash_only' | 'allow_trim_base';
    overlayMinBudgetUSD?: number;
    overlayMinBudgetPolicy?: 'gate' | 'warn';
    overlayMinOneShareRule?: boolean;
    maxTotalExposureCapPct?: number;
    deploymentTargets?: Array<{ symbol: string; weight: number }>;
    durationWeeks?: number;
    durationWeeksAdd?: number;
    durationWeeksHold?: number;
    cooldownWeeks?: number;
    exitCondition?: 'time_or_recovery';
    recoveryPctFromLow?: number;
    pacing?: {
      tierMaxDeployPctOfOverlayPerWeek?: Record<string, number>;
    };
    sleeveTag?: string;
    reintegrationMode?: 'passive';
    freezeBaseRebalanceDuringAddHold?: boolean;
    earlyExit?: {
      enabled?: boolean;
      riskOffConfidenceThreshold?: number;
      requiresRiskOffLabel?: boolean;
      deepDrawdownFailsafePct?: number;
    };
  };
  cadence: 'weekly' | 'hourly';
  policyGateMode?: 'scale' | 'block';
  round0MacroLagPolicy?: 'flags_warn' | 'summary_only';
  macroLagWarnDays?: number;
  macroLagErrorDays?: number;
  minExecutableNotionalUSD?: number;
  fractionalSharesSupported?: boolean;
  allowExecutionProxies?: boolean;
  capital?: {
    corePct?: number;
    reservePct?: number;
  };
  proxiesFile?: string;
  proxySelectionMode?: 'first_executable';
  maxProxyTrackingErrorAbs?: number;
  enableExposureGrouping?: boolean;
  exposureGroupsFile?: string;
  canonicalizeExposureGroups?: boolean;
  canonicalizeOnlyInPhase?: string[];
  canonicalizeMaxNotionalPctPerRun?: number;
  canonicalizeMinDriftToAct?: number;
  canonicalizeOnlyIfAffordable?: boolean;
  universeFile: string;
  baselinesEnabled: boolean;
  slippageBps: number;
  commissionPerTradeUSD: number;
  useLLM: boolean;
  requireApproval: boolean;
  optionsUnderlyings?: string[];
  hedgeProxyPolicy?: {
    hedgePreferred?: string[];
    growthPreferred?: string[];
  };
  insuranceReserveMode?: 'light' | 'full';
  insurance?: {
    spendPct?: number;
    minMonths?: number;
    maxMonths?: number;
    minMoneyness?: number;
    maxMoneyness?: number;
    limitPriceBufferPct?: number;
    closeWithinDays?: number;
    allowExpire?: boolean;
  };
  growth?: {
    spendPct?: number;
    minMonths?: number;
    maxMonths?: number;
    minMoneyness?: number;
    maxMoneyness?: number;
    limitPriceBufferPct?: number;
    closeWithinDays?: number;
    allowExpire?: boolean;
  };
  uiPort: number;
  uiBind: string;
}

export interface SymbolFeature {
  symbol: string;
  price: number;
  barInterval?: '1d' | '1w';
  return5d?: number;
  return20d?: number;
  return60d?: number;
  return60dPctile?: number;
  return60dPctileBucket?: 'low' | 'mid' | 'high' | 'unknown';
  realizedVol20d?: number;
  vol20dPctile?: number;
  vol20dPctileBucket?: 'low' | 'mid' | 'high' | 'unknown';
  maxDrawdown60d?: number;
  trend?: 'up' | 'down' | 'flat';
  above50dma?: boolean;
  above200dma?: boolean;
  dma50_gt_dma200?: boolean;
  ma50?: number;
  ma200?: number;
  historySamples?: number;
  historyUniqueCloses?: number;
}

export interface MacroSeriesPoint {
  date: string;
  value: number;
}

export interface MacroSeries {
  id: string;
  title?: string;
  points: MacroSeriesPoint[];
}

export interface RegimeContext {
  growth?: 'up' | 'down' | 'flat';
  inflation?: 'up' | 'down' | 'flat';
  policy?: 'tightening' | 'easing' | 'neutral';
  risk?: 'on' | 'off';
  equityRegime?: {
    label: 'risk_on' | 'risk_off' | 'neutral';
    confidence: number;
    transitionRisk?: 'low' | 'elevated' | 'high';
    supports?: {
      spyRet60d?: number;
      spyRet60dPctile?: number | null;
      spyRet60dBucket?: 'low' | 'mid' | 'high' | 'unknown';
      spyVolPctile?: number | null;
      spyVolPctileBucket?: 'low' | 'mid' | 'high' | 'unknown';
      spyTrend?: 'up' | 'down' | 'flat';
      historySamples?: number;
      historyUniqueCloses?: number;
    };
  };
  volRegime?: { label: 'low' | 'rising' | 'stressed'; confidence?: number };
  ratesRegime?: { label: 'rising' | 'falling' | 'stable'; stance?: 'restrictive' | 'neutral' | 'accommodative'; confidence?: number };
  breadth?: 'broad' | 'concentrated' | 'unknown';
}

export interface ContextMeta {
  sizeBytes: number;
  maxBytes: number;
  truncated: boolean;
  dropped?: string[];
  sources?: Record<string, unknown>;
  cacheHits?: Record<string, unknown>;
  rawContains?: Record<string, boolean>;
  payloadContains?: Record<string, boolean>;
  stage?: string;
  lineage?: { round4Hash?: string };
}

export interface RiskExposureSummary {
  currentCash: number;
  totalNotional: number;
  projectedCash: number;
  drawdown: number;
}

export interface RiskReport {
  asOf: string;
  approved: boolean;
  blockedReasons: string[];
  approvedOrders: TradeOrder[];
  exposureSummary: RiskExposureSummary;
  policyApplied?: Record<string, unknown>;
}

export interface ProposalResult {
  strategy: StrategyName;
  intent: TradeIntent;
}

export type LedgerEventType =
  | 'RUN_STARTED'
  | 'INPUTS_WRITTEN'
  | 'PROPOSAL_CREATED'
  | 'RISK_EVALUATED'
  | 'RUN_PENDING_APPROVAL'
  | 'RUN_APPROVED'
  | 'APPROVAL_OVERRIDE_USED'
  | 'RUN_REJECTED'
  | 'ORDER_PREVIEWED'
  | 'ORDER_PLACED'
  | 'FILL_RECORDED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'EXECUTION_SENT_TO_BROKER';

export interface LedgerEvent {
  id: string;
  runId: string;
  timestamp: string;
  type: LedgerEventType;
  details?: Record<string, unknown>;
}

export interface Holding {
  symbol: string;
  quantity: number;
  avgPrice: number;
  holdSince?: string;
}

export interface PortfolioState {
  cash: number;
  holdings: Holding[];
  equity: number;
}

export interface SleevePositions {
  [symbol: string]: {
    baseQty: number;
    dislocationQty: number;
    updatedAtISO: string;
  };
}

export interface OrderPreview {
  symbol: string;
  quantity: number;
  estimatedCost: number;
  fees: number;
  previewId?: string | number;
  quantityType?: 'DOLLAR' | 'QUANTITY';
}

export interface OrderPlacement extends OrderPreview {
  orderId: string | number;
  raw?: unknown;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  notional: number;
  timestamp: string;
}

export interface ExecutionResult {
  previews: OrderPreview[];
  placements: OrderPlacement[];
  fills: Fill[];
}

export interface RunInputs {
  asOf: string;
  config: BotConfig;
  universe: string[];
  portfolio: PortfolioState;
  quotes: Record<string, number>;
  history?: Record<string, PriceBar[]>;
  macro?: MacroSeries[];
  contextMeta?: ContextMeta;
}

export interface RunBundle {
  inputs: RunInputs;
  proposal: ProposalResult;
  risk: RiskReport;
  orders: TradeOrder[];
  fills: Fill[];
}

export interface EquityPoint {
  date: string;
  equity: number;
  exposure: number;
  drawdown: number;
  benchmarkSPY: number;
  deterministicEquity?: number;
  randomEquity?: number;
}

export interface LLMContextPacket {
  asOf: string;
  runId: string;
  universe: string[];
  portfolio: PortfolioState;
  quotes: Record<string, number>;
  features: SymbolFeature[];
  macro?: MacroSeries[];
  regimes?: RegimeContext;
  macroPolicy?: Record<string, unknown>;
  news?: { headline: string; url?: string; datetime?: string; source?: string }[];
  marketMemo?: Record<string, unknown>;
  dataQuality?: Record<string, DataQualityFlag[]>;
  eligibility?: Record<string, { tradable: boolean; reason?: string; maxNotional: number }>;
  executionCapabilities?: { fractionalShares: boolean; minExecutableNotionalUSD: number };
  constraints: Pick<
    BotConfig,
    | 'maxPositions'
    | 'maxTradesPerRun'
    | 'maxPositionPct'
    | 'minCashPct'
    | 'maxNotionalTradedPctPerRun'
    | 'minHoldHours'
    | 'maxWeeklyDrawdownPct'
  > & { cadence: BotConfig['cadence'] };
  contextMeta: ContextMeta;
  generatedAt: string;
}
