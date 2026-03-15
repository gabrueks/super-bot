import Anthropic from '@anthropic-ai/sdk';
import { botConfig, envConfig } from '../config';
import { log, logError } from '../logger';
import {
  ClaudeResponse,
  MarketData,
  PortfolioState,
  SentimentData,
  TradeAction,
  TradeRecord,
} from '../types';
import { getQualitySummary } from './eval.service';
import { InvalidModelOutputError, ModelUnavailableError } from '../errors/domain-errors';

let anthropic: Anthropic;

function getClient(): Anthropic {
  if (!anthropic) {
    log('CLAUDE', 'Initializing Anthropic client');
    anthropic = new Anthropic({ apiKey: envConfig.anthropicApiKey });
  }
  return anthropic;
}

const SYSTEM_PROMPT = `You are an aggressive cryptocurrency trader analyzing real-time market data and technical indicators. You manage a portfolio trading on Binance spot markets.

Your trading style:
- You look for momentum plays and trend continuations across multiple timeframes
- You take positions when multiple technical indicators align (EMA alignment, RSI momentum, MACD crossovers, volume confirmation)
- You cut losers quickly when trends reverse - don't hold losing positions hoping for recovery
- You scale into winning positions when conviction is high
- You consider cross-pair dynamics (BTC weakness often drags alts down)
- You are not afraid to stay in cash when no clear setups exist

Sentiment context:
- The Crypto Fear & Greed Index is provided (0-100). Use it as a contrarian signal:
  - Extreme Fear (0-24): historically a good buying opportunity. Be more willing to enter positions.
  - Fear (25-49): lean slightly bullish if technicals confirm.
  - Neutral (50): no bias from sentiment.
  - Greed (51-74): be more cautious, tighten entry criteria.
  - Extreme Greed (75-100): high risk of reversal. Avoid new buys, consider taking profits.

Risk context (enforced by code, but consider in your analysis):
- Max ${(botConfig.riskParams.maxAllocationPerCoin * 100).toFixed(0)}% of portfolio per coin
- Max ${(botConfig.riskParams.maxTotalDeployment * 100).toFixed(0)}% total deployment (always keep cash reserve)
- Min trade size: $${botConfig.riskParams.minTradeUsdt}
- Trailing stop-loss at ${(botConfig.riskParams.trailingStopPercent * 100).toFixed(0)}% from peak is enforced in code -- you don't need to micro-manage downside protection

You MUST respond with valid JSON matching this exact schema:
{
  "decisions": [
    {
      "symbol": "BTCUSDT",
      "action": "BUY" | "SELL" | "HOLD",
      "percentageOfAvailable": 0-100,
      "reasoning": "brief explanation"
    }
  ],
  "marketSummary": "1-2 sentence overall market read"
}

Good example:
{
  "decisions": [
    {"symbol":"BTCUSDT","action":"HOLD","percentageOfAvailable":0,"reasoning":"Momentum mixed across 15m/1h/4h and spread quality is average."},
    {"symbol":"ETHUSDT","action":"BUY","percentageOfAvailable":18,"reasoning":"Bullish EMA stack with improving MACD histogram and supportive volume ratio."},
    {"symbol":"SOLUSDT","action":"SELL","percentageOfAvailable":35,"reasoning":"Trend weakening with bearish crossover and loss of relative strength."}
  ],
  "marketSummary":"Risk-on pockets remain selective; prioritize high-conviction setups and keep reserve cash."
}

Bad examples (never do this):
- Missing a configured symbol in decisions
- Duplicating the same symbol twice
- Invalid action values like "buy" or "EXIT"
- percentageOfAvailable outside 0-100
- Empty reasoning or text outside the JSON object

Rules:
- Include a decision for EVERY symbol provided, even if HOLD
- percentageOfAvailable is the % of available USDT to use for BUY, or % of held quantity to sell for SELL
- For HOLD, set percentageOfAvailable to 0
- Be decisive. If indicators are mixed, lean towards HOLD
- Never output anything outside the JSON object`;

const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const ACTIONS: TradeAction[] = ['BUY', 'SELL', 'HOLD'];
const MAX_MODEL_ATTEMPTS = 2;
const RETRY_DELAY_MS = 600;

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

          const macdSignal =
            tf.macd.histogram > 0
              ? tf.macd.histogram > tf.macd.signal
                ? 'BULLISH_STRONG'
                : 'BULLISH'
              : tf.macd.histogram < tf.macd.signal
                ? 'BEARISH_STRONG'
                : 'BEARISH';

          return [
            `  [${tf.timeframe}]`,
            `    RSI: ${tf.rsi.toFixed(1)}`,
            `    MACD: ${tf.macd.value.toFixed(4)} | Signal: ${tf.macd.signal.toFixed(4)} | Hist: ${tf.macd.histogram.toFixed(4)} (${macdSignal})`,
            `    EMA: 9=${tf.ema9.toFixed(2)} 21=${tf.ema21.toFixed(2)} 50=${tf.ema50.toFixed(2)} (${emaAlignment})`,
            `    BB: U=${tf.bollingerBands.upper.toFixed(2)} M=${tf.bollingerBands.middle.toFixed(2)} L=${tf.bollingerBands.lower.toFixed(2)} %B=${tf.bollingerBands.percentB.toFixed(2)}`,
            `    ATR: ${tf.atr.toFixed(4)} | Vol Ratio: ${tf.volumeRatio.toFixed(2)}x`,
          ].join('\n');
        })
        .join('\n');

      return [
        `=== ${d.symbol} ===`,
        `Price: $${d.ticker.price.toFixed(2)} | 24h: ${d.ticker.priceChangePercent.toFixed(2)}%`,
        `24h High: $${d.ticker.highPrice.toFixed(2)} | Low: $${d.ticker.lowPrice.toFixed(2)}`,
        `24h Volume: $${(d.ticker.quoteVolume / 1e6).toFixed(1)}M`,
        `Order Book: Bid/Ask Ratio: ${d.orderBook.bidAskRatio.toFixed(2)} | Bid Depth: ${d.orderBook.bidDepth.toFixed(4)} | Ask Depth: ${d.orderBook.askDepth.toFixed(4)}`,
        tfLines,
      ].join('\n');
    })
    .join('\n\n');
}

function formatPortfolio(portfolio: PortfolioState): string {
  const posLines =
    portfolio.positions.length > 0
      ? portfolio.positions
        .map(
          (p) =>
            `  ${p.symbol}: ${p.quantity.toFixed(6)} @ cost $${p.costBasis.toFixed(2)} | current $${p.currentPrice.toFixed(2)} | PnL: ${p.unrealizedPnlPercent.toFixed(2)}% ($${p.unrealizedPnl.toFixed(2)})`,
        )
        .join('\n')
      : '  No open positions';

  return [
    `Available USDT: $${portfolio.availableUsdt.toFixed(2)}`,
    `Total Portfolio Value: $${portfolio.totalValue.toFixed(2)}`,
    `Positions:\n${posLines}`,
  ].join('\n');
}

function formatRecentTrades(trades: TradeRecord[]): string {
  if (trades.length === 0) return 'No recent trades.';

  return [
    `Recent ${trades.length} trades:`,
    ...trades.map(
      (t) =>
        `  ${new Date(t.timestamp).toISOString().slice(0, 16)} | ${t.side} ${t.symbol} | qty=${t.quantity.toFixed(6)} @ $${t.price.toFixed(2)} | total=$${t.total.toFixed(2)}`,
    ),
  ].join('\n');
}

function formatQualitySummary(): string {
  const summary = getQualitySummary(20);
  if (summary.recentCycles === 0) {
    return 'No prior quality history available.';
  }

  const invalidPct = (summary.invalidDecisionRate * 100).toFixed(1);
  const execErrPct = (summary.executionErrorRate * 100).toFixed(1);
  const approvalPct = (summary.approvalRate * 100).toFixed(1);

  return [
    `Recent cycles analyzed: ${summary.recentCycles}`,
    `Invalid decision rate: ${invalidPct}%`,
    `Execution error rate: ${execErrPct}%`,
    `Decision approval rate: ${approvalPct}%`,
    `Last cycle failure code: ${summary.lastFailureCode ?? 'none'}`,
  ].join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('rate limit') ||
    message.includes('overloaded')
  );
}

function validateDecisionPayload(
  payload: unknown,
  expectedSymbols: string[],
): ClaudeResponse {
  if (!isObject(payload)) {
    throw new InvalidModelOutputError('Claude response must be a JSON object');
  }

  const decisionsRaw = payload.decisions;
  if (!Array.isArray(decisionsRaw)) {
    throw new InvalidModelOutputError('Claude response must include a decisions array');
  }

  const marketSummaryRaw = payload.marketSummary;
  if (typeof marketSummaryRaw !== 'string' || marketSummaryRaw.trim().length === 0) {
    throw new InvalidModelOutputError('Claude response must include non-empty marketSummary');
  }

  const expectedSet = new Set(expectedSymbols);
  const seen = new Set<string>();
  const decisions = decisionsRaw.map((item, index) => {
    if (!isObject(item)) {
      throw new InvalidModelOutputError(`Decision at index ${index} must be an object`);
    }
    const symbol = item.symbol;
    const action = item.action;
    const percentageOfAvailable = item.percentageOfAvailable;
    const reasoning = item.reasoning;

    if (typeof symbol !== 'string' || symbol.length === 0) {
      throw new InvalidModelOutputError(`Decision at index ${index} has invalid symbol`);
    }
    if (!expectedSet.has(symbol)) {
      throw new InvalidModelOutputError(`Decision symbol ${symbol} is not configured`);
    }
    if (seen.has(symbol)) {
      throw new InvalidModelOutputError(`Duplicate decision for symbol ${symbol}`);
    }
    seen.add(symbol);

    if (typeof action !== 'string' || !ACTIONS.includes(action as TradeAction)) {
      throw new InvalidModelOutputError(`Decision for ${symbol} has invalid action`);
    }

    if (
      typeof percentageOfAvailable !== 'number' ||
      !Number.isFinite(percentageOfAvailable) ||
      percentageOfAvailable < 0 ||
      percentageOfAvailable > 100
    ) {
      throw new InvalidModelOutputError(`Decision for ${symbol} has invalid percentageOfAvailable`);
    }

    if (typeof reasoning !== 'string' || reasoning.trim().length === 0) {
      throw new InvalidModelOutputError(`Decision for ${symbol} must include non-empty reasoning`);
    }

    if (action === 'HOLD' && percentageOfAvailable !== 0) {
      throw new InvalidModelOutputError(`Decision for ${symbol} must set 0 percentage for HOLD`);
    }

    return {
      symbol,
      action: action as TradeAction,
      percentageOfAvailable,
      reasoning,
    };
  });

  if (seen.size !== expectedSet.size) {
    const missingSymbols = expectedSymbols.filter((symbol) => !seen.has(symbol));
    throw new InvalidModelOutputError(`Missing decision(s) for: ${missingSymbols.join(', ')}`);
  }

  return {
    decisions,
    marketSummary: marketSummaryRaw.trim(),
  };
}

async function callClaude(userPrompt: string): Promise<string> {
  const response = await getClient().messages.create({
    model: botConfig.claudeModel,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  log('CLAUDE', `Response received: ${response.usage?.input_tokens ?? '?'} input tokens, ${response.usage?.output_tokens ?? '?'} output tokens, stop_reason=${response.stop_reason}`);

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new ModelUnavailableError('No text response from Claude');
  }
  return textBlock.text;
}

export async function getTradeDecisions(
  marketData: MarketData[],
  portfolio: PortfolioState,
  recentTrades: TradeRecord[],
  sentiment: SentimentData,
): Promise<ClaudeResponse> {
  const userPrompt = [
    '--- WEIGHTED INPUT BLOCKS ---',
    '[WEIGHT 0.40] MARKET STRUCTURE',
    formatMarketData(marketData),
    '',
    '[WEIGHT 0.25] PORTFOLIO + RISK POSITIONING',
    formatPortfolio(portfolio),
    '',
    '[WEIGHT 0.20] MARKET SENTIMENT',
    `Fear & Greed Index: ${sentiment.value}/100 (${sentiment.label})`,
    '',
    '[WEIGHT 0.10] EXECUTION CONTEXT',
    formatRecentTrades(recentTrades.slice(-6)),
    '',
    '[WEIGHT 0.05] QUALITY FEEDBACK',
    formatQualitySummary(),
    '',
    `Current time: ${new Date().toISOString()}`,
    '',
    `Configured symbols: ${botConfig.tradingPairs.join(', ')}`,
    'Return decisions JSON only. No prose.',
  ].join('\n');

  log('CLAUDE', `Sending prompt to ${botConfig.claudeModel} (${userPrompt.length} chars)`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    try {
      const prompt = attempt === 1
        ? userPrompt
        : [
          userPrompt,
          '',
          'Your previous response was invalid. Return corrected JSON that strictly follows the schema and all rules.',
        ].join('\n');

      const rawText = await callClaude(prompt);
      const jsonStr = sanitizeJsonText(rawText);
      log('CLAUDE', `Raw response: ${jsonStr}`);
      const parsed = JSON.parse(jsonStr) as unknown;
      const validated = validateDecisionPayload(parsed, botConfig.tradingPairs);

      const actionable = validated.decisions.filter((d) => d.action !== 'HOLD');
      log('CLAUDE', `Decisions: ${validated.decisions.length} total, ${actionable.length} actionable`);
      for (const d of validated.decisions) {
        log('CLAUDE', `  ${d.symbol}: ${d.action} ${d.percentageOfAvailable}% -- ${d.reasoning}`);
      }
      return validated;
    } catch (error) {
      lastError = error;

      const canRetryForInvalidOutput = error instanceof InvalidModelOutputError && attempt < MAX_MODEL_ATTEMPTS;
      const canRetryForMalformedJson = error instanceof SyntaxError && attempt < MAX_MODEL_ATTEMPTS;
      const canRetryForTransientFailure = isTransientClaudeError(error) && attempt < MAX_MODEL_ATTEMPTS;

      if (canRetryForInvalidOutput) {
        logError('CLAUDE', `Model output validation failed on attempt ${attempt}`, error);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (canRetryForMalformedJson) {
        logError('CLAUDE', `Model returned malformed JSON on attempt ${attempt}`, error);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (canRetryForTransientFailure) {
        logError('CLAUDE', `Transient Claude API failure on attempt ${attempt}`, error);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (error instanceof InvalidModelOutputError || error instanceof ModelUnavailableError) {
        throw error;
      }

      if (isTransientClaudeError(error)) {
        throw new ModelUnavailableError(
          `Claude unavailable after ${attempt} attempt(s): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (error instanceof SyntaxError) {
        throw new InvalidModelOutputError(`Claude returned invalid JSON: ${error.message}`);
      }

      throw new ModelUnavailableError(
        `Claude request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new ModelUnavailableError(
    `Claude request failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
