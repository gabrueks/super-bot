export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface TickerStats {
  symbol: string;
  price: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bidAskRatio: number;
  topBidPrice: number;
  topAskPrice: number;
  bidDepth: number;
  askDepth: number;
}

export interface TimeframeIndicators {
  timeframe: string;
  rsi: number;
  macd: {
    value: number;
    signal: number;
    histogram: number;
  };
  ema9: number;
  ema21: number;
  ema50: number;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
    percentB: number;
  };
  atr: number;
  volumeRatio: number;
}

export interface TechnicalAnalysis {
  symbol: string;
  currentPrice: number;
  timeframes: TimeframeIndicators[];
}

export interface MarketData {
  symbol: string;
  ticker: TickerStats;
  orderBook: OrderBookSnapshot;
  technicalAnalysis: TechnicalAnalysis;
}

export interface Position {
  symbol: string;
  quantity: number;
  costBasis: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface PortfolioState {
  availableUsdt: number;
  totalValue: number;
  positions: Position[];
  lastUpdated: number;
  isBalanceDataStale?: boolean;
}

export type TradeSide = 'BUY' | 'SELL';
export type TradeAction = 'BUY' | 'SELL' | 'HOLD';

export interface TradeRecord {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  total: number;
  timestamp: number;
  reasoning: string;
}

export interface TradeDecision {
  symbol: string;
  action: TradeAction;
  percentageOfAvailable: number;
  reasoning: string;
}

export interface ClaudeResponse {
  decisions: TradeDecision[];
  marketSummary: string;
}

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedQuantity?: number;
}

export interface CycleResult {
  timestamp: number;
  decisionsReceived: number;
  decisionsApproved: number;
  tradesExecuted: number;
  trades: TradeRecord[];
  errors: string[];
  failureCode?: CycleFailureCode;
}

export type CycleFailureCode =
  | 'model_unavailable'
  | 'invalid_model_output'
  | 'market_data_unavailable'
  | 'execution_blocked'
  | 'margin_unavailable'
  | 'leverage_invalid'
  | 'position_not_found'
  | 'unknown_error';

export interface BotConfig {
  tradingPairs: string[];
  cronInterval: string;
  riskParams: RiskParams;
  claudeModel: string;
  stepSizes: Record<string, number>;
}

export interface RiskParams {
  maxAllocationPerCoin: number;
  maxTotalDeployment: number;
  minTradeUsdt: number;
  cooldownMinutes: number;
  maxDailyLossPercent: number;
  trailingStopPercent: number;
}

export interface SentimentData {
  value: number;
  label: string;
  timestamp: number;
}

export interface TrailingStop {
  symbol: string;
  entryPrice: number;
  peakPrice: number;
  activatedAt: number;
}

export interface QualityCycleMetric {
  timestamp: number;
  cycleDurationMs: number;
  decisionsReceived: number;
  decisionsApproved: number;
  tradesExecuted: number;
  rejectionCount: number;
  errorCount: number;
  invalidDecisionRate: number;
  executionSuccessRate: number;
  approvalRate: number;
  failureCode?: CycleFailureCode;
}

export interface QualitySummary {
  recentCycles: number;
  invalidDecisionRate: number;
  executionErrorRate: number;
  approvalRate: number;
  lastFailureCode?: CycleFailureCode;
}

export interface ShortQualityCycleMetric {
  timestamp: number;
  cycleDurationMs: number;
  decisionsReceived: number;
  decisionsApproved: number;
  tradesExecuted: number;
  rejectionCount: number;
  errorCount: number;
  invalidDecisionRate: number;
  executionSuccessRate: number;
  approvalRate: number;
  estimatedFeesUsdt: number;
  estimatedFundingUsdt: number;
  estimatedGrossPnlUsdt: number;
  estimatedNetPnlUsdt: number;
  failureCode?: CycleFailureCode;
}

export interface ShortQualitySummary {
  recentCycles: number;
  invalidDecisionRate: number;
  executionErrorRate: number;
  approvalRate: number;
  avgEstimatedFeesUsdt: number;
  avgEstimatedFundingUsdt: number;
  avgEstimatedGrossPnlUsdt: number;
  avgEstimatedNetPnlUsdt: number;
  lastFailureCode?: CycleFailureCode;
}

export type ShortTradeAction = 'OPEN_SHORT' | 'CLOSE_SHORT' | 'HOLD';

export interface ShortPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  notionalValue: number;
}

export interface ShortPortfolioState {
  availableUsdt: number;
  totalValue: number;
  positions: ShortPosition[];
  lastUpdated: number;
}

export interface ShortTradeRecord {
  id: string;
  symbol: string;
  side: 'OPEN_SHORT' | 'CLOSE_SHORT';
  quantity: number;
  price: number;
  total: number;
  estimatedFeesUsdt?: number;
  estimatedFundingUsdt?: number;
  estimatedGrossPnlUsdt?: number;
  estimatedNetPnlUsdt?: number;
  timestamp: number;
  reasoning: string;
}

export interface ShortTradeDecision {
  symbol: string;
  action: ShortTradeAction;
  percentageOfAvailable: number;
  reasoning: string;
}

export interface ShortClaudeResponse {
  decisions: ShortTradeDecision[];
  marketSummary: string;
}

export interface ShortRiskCheckResult {
  approved: boolean;
  reason?: string;
  adjustedNotionalUsdt?: number;
}

export interface ShortSymbolRiskInput {
  symbol: string;
  currentPrice: number;
  atr: number;
  stopDistanceUsdt: number;
  stopDistancePercent: number;
}

export interface ShortExecutionInput {
  symbol: string;
  midPrice: number;
  topBidPrice: number;
  topAskPrice: number;
  spreadPercent: number;
  bidAskRatio: number;
  atrPercent: number;
}

export type ShortMarketRegimeKind = 'BULL_TREND' | 'BEAR_TREND' | 'CHOPPY' | 'PANIC' | 'EUPHORIA';

export interface ShortMarketRegime {
  kind: ShortMarketRegimeKind;
  strength: number;
  breadth: number;
  averageRsi1h: number;
  sentimentValue: number;
}

export interface ShortCycleResult {
  timestamp: number;
  decisionsReceived: number;
  decisionsApproved: number;
  tradesExecuted: number;
  trades: ShortTradeRecord[];
  errors: string[];
  failureCode?: CycleFailureCode;
}

export interface ShortRiskParams {
  maxShortAllocationPerCoin: number;
  maxTotalShortExposure: number;
  minTradeUsdt: number;
  cooldownMinutes: number;
  maxDailyLossPercent: number;
  defaultLeverage: number;
  riskPerTradePercent: number;
  atrStopMultiplier: number;
  minStopDistancePercent: number;
  maxStopDistancePercent: number;
  maxSpreadPercent: number;
  minBidAskRatio: number;
  expectedMoveAtrMultiple: number;
  estimatedFundingCostPercent: number;
  minEdgeBufferPercent: number;
  openLimitOffsetBps: number;
  openLimitFallbackMinFillPercent: number;
}

export interface ShortBotConfig {
  tradingPairs: string[];
  cronInterval: string;
  riskParams: ShortRiskParams;
  claudeModel: string;
  stepSizes: Record<string, number>;
}
