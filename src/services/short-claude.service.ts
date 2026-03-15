import Anthropic from '@anthropic-ai/sdk';
import { envConfig, shortBotConfig } from '../config';
import { log, logError } from '../logger';
import {
  MarketData,
  SentimentData,
  ShortClaudeResponse,
  ShortPortfolioState,
  ShortTradeRecord,
} from '../types';
import { InvalidModelOutputError, ModelUnavailableError } from '../errors/domain-errors';
import { validateShortDecisionPayload } from '../dto/short-decision.dto';

const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_MODEL_ATTEMPTS = 2;
const RETRY_DELAY_MS = 600;

let anthropic: Anthropic;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: envConfig.anthropicApiKey });
  }
  return anthropic;
}

const SHORT_SYSTEM_PROMPT = `You are an aggressive Binance Futures short trader focused on downside momentum.

Your goal is to identify short opportunities and actively manage existing short positions.

Risk context:
- Max ${(shortBotConfig.riskParams.maxShortAllocationPerCoin * 100).toFixed(0)}% short exposure per symbol
- Max ${(shortBotConfig.riskParams.maxTotalShortExposure * 100).toFixed(0)}% total short exposure
- Min trade size: $${shortBotConfig.riskParams.minTradeUsdt}
- Default leverage: ${shortBotConfig.riskParams.defaultLeverage}x

You MUST respond with valid JSON matching this exact schema:
{
  "decisions": [
    {
      "symbol": "BTCUSDT",
      "action": "OPEN_SHORT" | "CLOSE_SHORT" | "HOLD",
      "percentageOfAvailable": 0-100,
      "reasoning": "brief explanation"
    }
  ],
  "marketSummary": "1-2 sentence overall market read"
}

Rules:
- Include a decision for EVERY configured symbol
- OPEN_SHORT uses % of available USDT margin
- CLOSE_SHORT uses % of current short position size
- HOLD must have percentageOfAvailable = 0
- Output JSON only`;

function formatMarketData(data: MarketData[]): string {
  return data
    .map((d) => {
      const tfLines = d.technicalAnalysis.timeframes
        .map((tf) => {
          const emaAlignment =
            tf.ema9 > tf.ema21 && tf.ema21 > tf.ema50
              ? 'BULLISH'
              : tf.ema9 < tf.ema21 && tf.ema21 < tf.ema50
                ? 'BEARISH'
                : 'MIXED';
          return [
            `  [${tf.timeframe}] RSI=${tf.rsi.toFixed(1)} MACD_HIST=${tf.macd.histogram.toFixed(4)} EMA_STACK=${emaAlignment} VOL_RATIO=${tf.volumeRatio.toFixed(2)}x`,
          ].join('\n');
        })
        .join('\n');

      return [
        `=== ${d.symbol} ===`,
        `Price: $${d.ticker.price.toFixed(2)} | 24h: ${d.ticker.priceChangePercent.toFixed(2)}%`,
        `Bid/Ask Ratio: ${d.orderBook.bidAskRatio.toFixed(2)}`,
        tfLines,
      ].join('\n');
    })
    .join('\n\n');
}

function formatShortPortfolio(portfolio: ShortPortfolioState): string {
  const lines = portfolio.positions.length > 0
    ? portfolio.positions.map((p) =>
      `${p.symbol}: qty=${p.quantity.toFixed(6)} entry=$${p.entryPrice.toFixed(2)} mark=$${p.currentPrice.toFixed(2)} pnl=${p.unrealizedPnlPercent.toFixed(2)}% notional=$${p.notionalValue.toFixed(2)}`)
    : ['No open short positions'];
  return [
    `Available USDT margin: $${portfolio.availableUsdt.toFixed(2)}`,
    `Wallet equity: $${portfolio.totalValue.toFixed(2)}`,
    ...lines,
  ].join('\n');
}

function formatRecentShortTrades(trades: ShortTradeRecord[]): string {
  if (trades.length === 0) {
    return 'No recent short trades.';
  }
  return trades
    .map((trade) =>
      `${new Date(trade.timestamp).toISOString().slice(0, 16)} | ${trade.side} ${trade.symbol} qty=${trade.quantity.toFixed(6)} @ $${trade.price.toFixed(2)} total=$${trade.total.toFixed(2)}`)
    .join('\n');
}

function sanitizeJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
}

function isTransientClaudeError(error: unknown): boolean {
  if (!(error && typeof error === 'object')) {
    return false;
  }
  const errorLike = error as {
    status?: number;
    statusCode?: number;
    error?: { type?: string; status?: number };
    message?: string;
  };
  const status = errorLike.status ?? errorLike.statusCode ?? errorLike.error?.status;
  if (typeof status === 'number' && TRANSIENT_STATUS_CODES.has(status)) {
    return true;
  }
  const message = (errorLike.message ?? '').toLowerCase();
  return (
    message.includes('timeout')
    || message.includes('temporarily unavailable')
    || message.includes('rate limit')
    || message.includes('overloaded')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function callClaude(userPrompt: string): Promise<string> {
  const response = await getClient().messages.create({
    model: shortBotConfig.claudeModel,
    max_tokens: 2048,
    system: SHORT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new ModelUnavailableError('No text response from Claude');
  }
  return textBlock.text;
}

export async function getShortTradeDecisions(
  marketData: MarketData[],
  portfolio: ShortPortfolioState,
  recentTrades: ShortTradeRecord[],
  sentiment: SentimentData,
): Promise<ShortClaudeResponse> {
  const userPrompt = [
    '[MARKET]',
    formatMarketData(marketData),
    '',
    '[SHORT_PORTFOLIO]',
    formatShortPortfolio(portfolio),
    '',
    '[SENTIMENT]',
    `Fear & Greed Index: ${sentiment.value}/100 (${sentiment.label})`,
    '',
    '[RECENT_SHORT_TRADES]',
    formatRecentShortTrades(recentTrades.slice(-6)),
    '',
    `Configured symbols: ${shortBotConfig.tradingPairs.join(', ')}`,
    `Current time: ${new Date().toISOString()}`,
    'Return decisions JSON only.',
  ].join('\n');

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    try {
      const prompt = attempt === 1
        ? userPrompt
        : `${userPrompt}\n\nYour previous response was invalid. Return corrected JSON strictly following schema and rules.`;
      const rawText = await callClaude(prompt);
      const jsonStr = sanitizeJsonText(rawText);
      const parsed = JSON.parse(jsonStr) as unknown;
      const validated = validateShortDecisionPayload(parsed, shortBotConfig.tradingPairs);
      return validated;
    } catch (error) {
      lastError = error;
      const canRetryForInvalidOutput = error instanceof InvalidModelOutputError && attempt < MAX_MODEL_ATTEMPTS;
      const canRetryForMalformedJson = error instanceof SyntaxError && attempt < MAX_MODEL_ATTEMPTS;
      const canRetryForTransientFailure = isTransientClaudeError(error) && attempt < MAX_MODEL_ATTEMPTS;

      if (canRetryForInvalidOutput || canRetryForMalformedJson || canRetryForTransientFailure) {
        logError('SHORT-CLAUDE', `Retrying short model call attempt ${attempt}`, error);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (error instanceof InvalidModelOutputError || error instanceof ModelUnavailableError) {
        throw error;
      }

      if (isTransientClaudeError(error)) {
        throw new ModelUnavailableError(
          `Short Claude unavailable after ${attempt} attempt(s): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (error instanceof SyntaxError) {
        throw new InvalidModelOutputError(`Short Claude returned invalid JSON: ${error.message}`);
      }

      throw new ModelUnavailableError(
        `Short Claude request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  log(
    'SHORT-CLAUDE',
    `Exhausted retries for short decisions: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  throw new ModelUnavailableError(
    `Short Claude request failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
