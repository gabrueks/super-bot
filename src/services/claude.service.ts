import Anthropic from '@anthropic-ai/sdk';
import { botConfig, envConfig } from '../config';
import { log, logError } from '../logger';
import {
  ClaudeResponse,
  MarketData,
  PortfolioState,
  TradeRecord
} from '../types';

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

Risk context (enforced by code, but consider in your analysis):
- Max ${(botConfig.riskParams.maxAllocationPerCoin * 100).toFixed(0)}% of portfolio per coin
- Max ${(botConfig.riskParams.maxTotalDeployment * 100).toFixed(0)}% total deployment (always keep cash reserve)
- Min trade size: $${botConfig.riskParams.minTradeUsdt}

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

Rules:
- Include a decision for EVERY symbol provided, even if HOLD
- percentageOfAvailable is the % of available USDT to use for BUY, or % of held quantity to sell for SELL
- For HOLD, set percentageOfAvailable to 0
- Be decisive. If indicators are mixed, lean towards HOLD
- Never output anything outside the JSON object`;

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

export async function getTradeDecisions(
  marketData: MarketData[],
  portfolio: PortfolioState,
  recentTrades: TradeRecord[],
): Promise<ClaudeResponse> {
  const userPrompt = [
    '--- MARKET DATA ---',
    formatMarketData(marketData),
    '',
    '--- PORTFOLIO ---',
    formatPortfolio(portfolio),
    '',
    '--- RECENT TRADES ---',
    formatRecentTrades(recentTrades),
    '',
    `Current time: ${new Date().toISOString()}`,
    '',
    'Analyze all pairs and return your trading decisions as JSON.',
  ].join('\n');

  log('CLAUDE', `Sending prompt to ${botConfig.claudeModel} (${userPrompt.length} chars)`);

  const response = await getClient().messages.create({
    model: botConfig.claudeModel,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  log('CLAUDE', `Response received: ${response.usage?.input_tokens ?? '?'} input tokens, ${response.usage?.output_tokens ?? '?'} output tokens, stop_reason=${response.stop_reason}`);

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  let jsonStr = textBlock.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  log('CLAUDE', `Raw response: ${jsonStr})}`);

  let parsed: ClaudeResponse;
  try {
    parsed = JSON.parse(jsonStr) as ClaudeResponse;
  } catch (e) {
    logError('CLAUDE', 'Failed to parse JSON response', e);
    logError('CLAUDE', `Full response was: ${jsonStr}`);
    throw new Error(`Claude returned invalid JSON: ${(e as Error).message}`);
  }

  if (!parsed.decisions || !Array.isArray(parsed.decisions)) {
    throw new Error('Invalid response structure from Claude');
  }

  for (const d of parsed.decisions) {
    if (!d.symbol || !d.action || d.percentageOfAvailable === undefined) {
      throw new Error(`Invalid decision entry: ${JSON.stringify(d)}`);
    }
  }

  const actionable = parsed.decisions.filter((d) => d.action !== 'HOLD');
  log('CLAUDE', `Decisions: ${parsed.decisions.length} total, ${actionable.length} actionable`);
  for (const d of parsed.decisions) {
    log('CLAUDE', `  ${d.symbol}: ${d.action} ${d.percentageOfAvailable}% -- ${d.reasoning}`);
  }

  return parsed;
}
