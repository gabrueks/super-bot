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
}

export interface BotConfig {
  tradingPairs: string[];
  cronInterval: string;
  riskParams: RiskParams;
  claudeModel: string;
}

export interface RiskParams {
  maxAllocationPerCoin: number;
  maxTotalDeployment: number;
  minTradeUsdt: number;
  cooldownMinutes: number;
  maxDailyLossPercent: number;
}
