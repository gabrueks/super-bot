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
