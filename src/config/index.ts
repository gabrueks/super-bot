import dotenv from 'dotenv';
import { BotConfig, RiskParams } from '../types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const envConfig = {
  binanceApiKey: requireEnv('BINANCE_API_KEY'),
  binanceApiSecret: requireEnv('BINANCE_API_SECRET'),
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
} as const;

export const riskParams: RiskParams = {
  maxAllocationPerCoin: 0.30,
  maxTotalDeployment: 0.75,
  minTradeUsdt: 5,
  cooldownMinutes: 15,
  maxDailyLossPercent: 0.05,
  trailingStopPercent: 0.04,
};

export const botConfig: BotConfig = {
  tradingPairs: [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
  ],
  cronInterval: '*/15 * * * *',
  riskParams,
  claudeModel: 'claude-sonnet-4-20250514',
  stepSizes: {
    BTCUSDT: 0.00001,
    ETHUSDT: 0.0001,
    SOLUSDT: 0.01,
  },
};

export const TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const DATA_DIR = 'data';
export const TRADE_HISTORY_FILE = `${DATA_DIR}/trade-history.json`;
export const PORTFOLIO_STATE_FILE = `${DATA_DIR}/portfolio-state.json`;
export const DAILY_SNAPSHOT_FILE = `${DATA_DIR}/daily-snapshot.json`;
export const TRAILING_STOPS_FILE = `${DATA_DIR}/trailing-stops.json`;
export const QUALITY_METRICS_FILE = `${DATA_DIR}/quality-metrics.json`;
